const https = require('https');
const { S3Client, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const s3 = new S3Client();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

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

            // 2. Extract text and language
            let transcriptText = "Could not extract text.";

            if (transcriptJson.results) {
                if (transcriptJson.results.transcripts && transcriptJson.results.transcripts.length > 0) {
                    transcriptText = transcriptJson.results.transcripts[0].transcript;
                }
            }
            console.log(`Extracted text: ${transcriptText.substring(0, 50)}...`);

            // 3. Find who to send it to. 
            // The n8n workflow used the file_unique_id to map back, but here we are stateless.
            // We need to store the chatId somewhere or encode it in the filename/jobname.
            // A simple hack: We can't easily pass metadata through Transcribe Output Key without managing it.
            // 
            // ALTERNATIVE: We can use S3 Metadata on the INPUT file, but Transcribe doesn't propagate it to output.
            //
            // BETTER APPROACH for this simple V1:
            // Since we don't have a database, we can't look up the ChatID from the JobName easily unless we encode it.
            // Let's update the Webhook to encode ChatID in the JobName or Output Key.
            //
            // Let's assume the Webhook saves the file as `input / CHATID_FILEID.ext`
            // And output is `output / CHATID_FILEID.json`
            // Then we can parse ChatID from the key.

            // Let's parse the key: output/CHATID_FILEUNIQUEID.json
            const filename = key.split('/').pop(); // CHATID_FILEUNIQUEID.json
            const parts = filename.split('_');

            if (parts.length < 2) {
                console.error("Filename format not recognized for extraction:", filename);
                continue;
            }

            const chatId = parts[0];
            console.log(`Identified Chat ID: ${chatId} `);

            // 4. Send Telegram Message
            console.log('Sending message to Telegram...');
            await sendTelegramMessage(chatId, transcriptText);
            console.log('Message sent to Telegram.');

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
            // Use the base name to find the input file (ignoring extension)
            const baseName = filename.replace(/\.json$/, '');
            const inputPrefix = `input/${baseName}`;
            console.log(`Searching for input file with prefix: ${inputPrefix}`);

            try {
                const listCmd = new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: inputPrefix
                });
                const listedObjects = await s3.send(listCmd);

                if (listedObjects.Contents && listedObjects.Contents.length > 0) {
                    for (const content of listedObjects.Contents) {
                        // Double check that it belongs to this job (prefix match is loose)
                        if (content.Key.startsWith(inputPrefix)) {
                            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: content.Key }));
                            console.log(`Deleted input file: ${content.Key}`);
                        }
                    }
                } else {
                    console.log('No input files found to delete.');
                }
            } catch (e) {
                console.error('Error during input file cleanup:', e);
            }
        }

        return { statusCode: 200, body: 'OK' };

    } catch (error) {
        console.error('Error processing event:', error);
        return { statusCode: 500, body: error.message };
    }
};

// Helpers
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
