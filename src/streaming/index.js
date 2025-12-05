const { S3Client, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const https = require('https');
const { spawn } = require('child_process');
const path = require('path');

const s3 = new S3Client();
const transcribe = new TranscribeStreamingClient({ region: process.env.AWS_REGION });
const ddbClient = new DynamoDBClient();
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const USAGE_TABLE = process.env.USAGE_TABLE;

exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event));

    const { bucket, key, chatId, messageId, startTime } = event;

    if (!bucket || !key || !chatId) {
        console.error('Missing required parameters');
        return;
    }

    try {
        // 1. Get Audio Stream from S3
        console.log(`Fetching file: ${key} from bucket: ${bucket}`);
        const s3Response = await s3.send(new GetObjectCommand({
            Bucket: bucket,
            Key: key
        }));

        // 2. Setup FFmpeg for Conversion (OGG -> PCM)
        // When using a Layer, the binary is at /opt/bin/ffmpeg
        const ffmpegPath = '/opt/bin/ffmpeg';
        console.log(`Spawning FFmpeg from: ${ffmpegPath}`);

        const ffmpeg = spawn(ffmpegPath, [
            '-i', 'pipe:0',           // Input from stdin
            '-f', 's16le',            // Output format: signed 16-bit little-endian PCM
            '-ac', '1',               // Audio channels: 1 (Mono)
            '-ar', '16000',           // Sample rate: 16000Hz (Good for speech)
            'pipe:1'                  // Output to stdout
        ]);

        // Pipe S3 stream to FFmpeg stdin
        s3Response.Body.pipe(ffmpeg.stdin);

        // Handle FFmpeg errors
        ffmpeg.stderr.on('data', (data) => {
            // console.log(`FFmpeg stderr: ${data}`); 
        });

        ffmpeg.on('close', (code) => {
            console.log(`FFmpeg process exited with code ${code}`);
        });

        // 3. Start Transcription Stream with PCM
        console.log('Starting Transcribe Stream (PCM)...');

        const audioStream = async function* () {
            const CHUNK_SIZE = 1024 * 4; // 4KB chunks
            for await (const chunk of ffmpeg.stdout) {
                if (chunk.length <= CHUNK_SIZE) {
                    yield { AudioEvent: { AudioChunk: chunk } };
                } else {
                    let offset = 0;
                    while (offset < chunk.length) {
                        const end = Math.min(offset + CHUNK_SIZE, chunk.length);
                        const slice = chunk.slice(offset, end);
                        yield { AudioEvent: { AudioChunk: slice } };
                        offset += CHUNK_SIZE;
                    }
                }
            }
        };

        const command = new StartStreamTranscriptionCommand({
            IdentifyLanguage: true,
            LanguageOptions: "en-US,he-IL",
            MediaEncoding: 'pcm',
            MediaSampleRateHertz: 16000,
            AudioStream: audioStream()
        });

        const response = await transcribe.send(command);

        // 4. Process Stream
        let fullTranscript = "";
        let lastPartial = ""; // Track the latest partial result
        let lastUpdateTime = Date.now();
        let lastUpdateText = "";
        let detectedLanguage = "unknown";
        let duration = 0;

        for await (const event of response.TranscriptResultStream) {
            if (event.TranscriptEvent) {
                const results = event.TranscriptEvent.Transcript.Results;
                if (results.length > 0) {
                    const result = results[0];

                    // Capture stats
                    if (result.EndTime) {
                        duration = result.EndTime;
                    }
                    if (result.LanguageCode) {
                        detectedLanguage = result.LanguageCode;
                    }

                    if (!result.IsPartial) {
                        // Finalized segment
                        const text = result.Alternatives[0].Transcript;
                        fullTranscript += text + " ";
                        lastPartial = ""; // Reset partial as we have finalized it
                    } else {
                        // Partial segment
                        const partialText = result.Alternatives[0].Transcript;
                        lastPartial = partialText; // Update latest partial

                        const currentDisplay = fullTranscript + partialText;

                        // Update Telegram every ~2 seconds
                        if (Date.now() - lastUpdateTime > 2000 && currentDisplay !== lastUpdateText) {
                            await editTelegramMessage(chatId, messageId, "🎧 " + currentDisplay);
                            lastUpdateTime = Date.now();
                            lastUpdateText = currentDisplay;
                        }
                    }
                }
            }
        }

        // Use last partial if full transcript is empty or if there's trailing text
        if (lastPartial) {
            fullTranscript += lastPartial;
        }

        // 5. Final Update
        const firstWord = fullTranscript.trim().split(' ')[0];
        console.log(`Transcription complete. First word: "${firstWord}..." (Redacted for privacy)`);
        await editTelegramMessage(chatId, messageId, "✅ " + fullTranscript);

        // 6. Cleanup
        try {
            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
            console.log('Deleted input file.');
        } catch (e) {
            console.error('Failed to delete input file:', e);
        }

        // 7. Update Stats
        console.log(`Stats - Language: ${detectedLanguage}, Duration: ${duration}s`);
        if (USAGE_TABLE) {
            try {
                // Update DynamoDB
                await updateStats(chatId, detectedLanguage, duration, 0); // Size is 0 or unknown here, skipping size tracking for streaming for now

                // Send Stats Message
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

                const thisNote = `${formatDur(duration)} (${detectedLanguage})`;
                const total = formatDur(totalSec);

                const statsMsg = `⏱️ ${thisNote} | 📈 Total: ${total}`;
                await sendTelegramMessage(chatId, statsMsg);
                console.log('Stats message sent.');

            } catch (e) {
                console.error("Failed to update/send stats:", e);
            }
        }

    } catch (error) {
        console.error('Error in streaming processor:', error);
        await editTelegramMessage(chatId, messageId, "❌ Error processing transcription.");
    }
};

async function editTelegramMessage(chatId, messageId, text) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: text
        });

        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_TOKEN}/editMessageText`,
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

async function sendTelegramMessage(chatId, text) {
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

async function updateStats(chatId, language, durationSec, sizeKB) {
    if (!USAGE_TABLE) return;
    const updates = [
        { pk: 'GLOBAL', name: 'Global' },
        { pk: `USER#${chatId}`, name: 'User' }
    ];

    for (const update of updates) {
        try {
            await performUpdate(update.pk, language, durationSec, sizeKB);
        } catch (e) {
            if (e.name === 'ValidationException') {
                try {
                    await ddbDocClient.send(new UpdateCommand({
                        TableName: USAGE_TABLE,
                        Key: { PK: update.pk },
                        UpdateExpression: "SET seconds_by_language = if_not_exists(seconds_by_language, :empty), transcriptions_by_language = if_not_exists(transcriptions_by_language, :empty)",
                        ExpressionAttributeValues: { ":empty": {} }
                    }));
                    await performUpdate(update.pk, language, durationSec, sizeKB);
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
        ExpressionAttributeNames: { "#lang": language },
        ExpressionAttributeValues: {
            ":dur": durationSec,
            ":kb": sizeKB,
            ":inc": 1,
            ":zero": 0
        }
    }));
}
