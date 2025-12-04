const https = require('https');
const { S3Client, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const s3 = new S3Client();
const ddbClient = new DynamoDBClient();
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const USAGE_TABLE = process.env.USAGE_TABLE;

exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event));

    try {
        for (const record of event.Records) {
            const bucket = record.s3.bucket.name;
            const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
            console.log(`Processing file: ${key} from bucket: ${bucket} `);

            // 1. Get the transcript JSON
            console.log('Fetching transcript JSON from S3...');
            const response = await s3.send(new GetObjectCommand({
                Bucket: bucket,
                Key: key
            }));

            const bodyContents = await streamToString(response.Body);
            console.log('Transcript JSON fetched successfully.');
            // console.log('Transcript JSON content:', bodyContents); // Uncomment if needed, but might be large

            const transcriptJson = JSON.parse(bodyContents);

            // 2. Extract text, language, duration
            let transcriptText = "Could not extract text.";
            let languageCode = "unknown";
            let duration = 0;

            if (transcriptJson.results) {
                if (transcriptJson.results.transcripts && transcriptJson.results.transcripts.length > 0) {
                    transcriptText = transcriptJson.results.transcripts[0].transcript;
                }
                if (transcriptJson.results.language_code) {
                    languageCode = transcriptJson.results.language_code;
                }
                if (transcriptJson.results.items && transcriptJson.results.items.length > 0) {
                    // Iterate backwards to find the last item with an end_time (ignoring punctuation)
                    for (let i = transcriptJson.results.items.length - 1; i >= 0; i--) {
                        const item = transcriptJson.results.items[i];
                        if (item.end_time) {
                            duration = parseFloat(item.end_time);
                            break;
                        }
                    }
                    if (duration === 0) {
                        console.log("Could not find any item with end_time. Last item:", JSON.stringify(transcriptJson.results.items[transcriptJson.results.items.length - 1]));
                    }
                } else {
                    console.log("No items found in transcriptJson.results");
                }
            }
            console.log(`Extracted text: ${transcriptText.substring(0, 50)}...`);
            console.log(`Stats - Language: ${languageCode}, Duration: ${duration}s`);

            // 3. Find who to send it to.
            const filename = key.split('/').pop(); // CHATID_FILEUNIQUEID.json
            const parts = filename.split('_');

            if (parts.length < 2) {
                console.error("Filename format not recognized for extraction:", filename);
                continue;
            }

            const chatId = parts[0];
            console.log(`Identified Chat ID: ${chatId} `);

            // 3.5 Find Input File (for size and later deletion)
            const baseName = filename.replace(/\.json$/, '');
            const inputPrefix = `input/${baseName}`;
            let inputFiles = [];
            let totalSizeBytes = 0;

            try {
                const listCmd = new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: inputPrefix
                });
                const listedObjects = await s3.send(listCmd);
                if (listedObjects.Contents) {
                    inputFiles = listedObjects.Contents.filter(c => c.Key.startsWith(inputPrefix));
                    if (inputFiles.length > 0) {
                        totalSizeBytes = inputFiles[0].Size; // Assume first file is the audio
                    }
                }
            } catch (e) {
                console.error("Error listing input files:", e);
            }
            console.log(`Input file size: ${totalSizeBytes} bytes`);

            // 4. Send Telegram Message
            console.log('Sending message to Telegram...');
            await sendTelegramMessage(chatId, transcriptText);
            console.log('Message sent to Telegram.');

            // 4.5 Update Stats
            // 4.5 Update Stats
            await updateStats(chatId, languageCode, duration, totalSizeBytes);

            // 4.6 Send Stats Message
            if (USAGE_TABLE) {
                try {
                    const userStats = await ddbDocClient.send(new GetCommand({
                        TableName: USAGE_TABLE,
                        Key: { PK: `USER#${chatId}` }
                    }));
                    const u = userStats.Item || {};
                    const totalSec = u.total_seconds || 0;

                    const formatDur = (sec) => {
                        const m = Math.floor(sec / 60);
                        const s = Math.floor(sec % 60);
                        return m > 0 ? `${m}m ${s}s` : `${s}s`;
                    };

                    const thisNote = `${formatDur(duration)} (${languageCode})`;
                    const total = formatDur(totalSec);

                    const statsMsg = `⏱️ ${thisNote} | 📈 Total: ${total}`;
                    await sendTelegramMessage(chatId, statsMsg);
                    console.log('Stats message sent.');
                } catch (e) {
                    console.error("Failed to send stats message:", e);
                }
            }

            // 5. Cleanup
            console.log('Starting cleanup...');

            // Delete the output JSON
            try {
                await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
                console.log(`Deleted output file: ${key}`);
            } catch (e) {
                console.error(`Failed to delete output file ${key}:`, e);
            }

            // Delete the input audio file
            if (inputFiles.length > 0) {
                for (const file of inputFiles) {
                    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: file.Key }));
                    console.log(`Deleted input file: ${file.Key}`);
                }
            } else {
                console.log('No input files found to delete.');
            }
        }

        return { statusCode: 200, body: 'OK' };

    } catch (error) {
        console.error('Error processing event:', error);
        return { statusCode: 500, body: error.message };
    }
};

// Helpers
async function updateStats(chatId, language, durationSec, sizeBytes) {
    if (!USAGE_TABLE) return;
    const sizeKB = Math.round(sizeBytes / 1024);
    const updates = [
        { pk: 'GLOBAL', name: 'Global' },
        { pk: `USER#${chatId}`, name: 'User' }
    ];

    for (const update of updates) {
        try {
            await performUpdate(update.pk, language, durationSec, sizeKB);
            console.log(`${update.name} stats updated.`);
        } catch (e) {
            if (e.name === 'ValidationException') {
                console.log(`Initializing maps for ${update.name} and retrying...`);
                try {
                    // Initialize maps if they don't exist
                    await ddbDocClient.send(new UpdateCommand({
                        TableName: USAGE_TABLE,
                        Key: { PK: update.pk },
                        UpdateExpression: "SET seconds_by_language = if_not_exists(seconds_by_language, :empty), transcriptions_by_language = if_not_exists(transcriptions_by_language, :empty)",
                        ExpressionAttributeValues: {
                            ":empty": {}
                        }
                    }));
                    // Retry original update
                    await performUpdate(update.pk, language, durationSec, sizeKB);
                    console.log(`${update.name} stats updated (after init).`);
                } catch (retryError) {
                    console.error(`Failed to update ${update.name} stats after init:`, retryError);
                }
            } else {
                console.error(`Failed to update ${update.name} stats:`, e);
            }
        }
    }
}

async function performUpdate(pk, language, durationSec, sizeKB) {
    await ddbDocClient.send(new UpdateCommand({
        TableName: USAGE_TABLE,
        Key: { PK: pk },
        UpdateExpression: "SET total_seconds = if_not_exists(total_seconds, :zero) + :dur, total_kbytes = if_not_exists(total_kbytes, :zero) + :kb, total_transcriptions = if_not_exists(total_transcriptions, :zero) + :inc, seconds_by_language.#lang = if_not_exists(seconds_by_language.#lang, :zero) + :dur, transcriptions_by_language.#lang = if_not_exists(transcriptions_by_language.#lang, :zero) + :inc",
        ExpressionAttributeNames: {
            "#lang": language
        },
        ExpressionAttributeValues: {
            ":dur": durationSec,
            ":kb": sizeKB,
            ":inc": 1,
            ":zero": 0
        }
    }));
}

function streamToString(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
}

function sendTelegramMessage(chatId, text) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ chat_id: chatId, text: text });
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };
        const req = https.request(options, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => responseBody += chunk);
            res.on('end', () => resolve(JSON.parse(responseBody)));
        });
        req.on('error', (e) => reject(e));
        req.write(data);
        req.end();
    });
}
