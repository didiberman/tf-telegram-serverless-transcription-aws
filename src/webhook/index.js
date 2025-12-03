const https = require('https');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { TranscribeClient, StartTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');

const s3 = new S3Client();
const transcribe = new TranscribeClient();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BUCKET_NAME = process.env.BUCKET_NAME;
// Parse allowed users from comma-separated string, or allow all if empty
const ALLOWED_USERNAMES = process.env.ALLOWED_USERNAMES ? process.env.ALLOWED_USERNAMES.split(',').map(u => u.trim()) : [];

exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event));

    try {
        const body = JSON.parse(event.body);

        // Handle Telegram "pre-checkout" or other service messages if needed, 
        // but for now we focus on messages.
        if (!body.message) {
            console.log('Received event with no message body. Ignoring.');
            return { statusCode: 200, body: 'OK' };
        }

        const chatId = body.message.chat.id;
        const username = body.message.chat.username;
        const firstName = body.message.chat.first_name;

        console.log(`Received message from User: ${username} (${firstName}), ChatID: ${chatId}`);

        // 1. Check permissions
        // If ALLOWED_USERNAMES is empty, allow everyone (optional, but safer to restrict)
        if (ALLOWED_USERNAMES.length > 0 && !ALLOWED_USERNAMES.includes(username)) {
            await sendTelegramMessage(chatId, "Sorry, you are not authorized to use this bot.");
            return { statusCode: 200, body: 'Unauthorized' };
        }

        // 2. Check for voice/audio
        const voice = body.message.voice || body.message.audio;
        if (!voice) {
            // Not an audio message, ignore or reply
            return { statusCode: 200, body: 'No audio' };
        }

        const fileId = voice.file_id;
        const fileUniqueId = voice.file_unique_id;
        // Get file extension or default to .ogg for voice notes
        const mimeType = voice.mime_type || 'audio/ogg';
        let ext = mimeType.split('/')[1] || 'ogg';
        if (ext === 'x-wav') ext = 'wav'; // Common fix

        // 3. Get File Path from Telegram
        const fileInfo = await getTelegramFileInfo(fileId);
        const filePath = fileInfo.file_path;

        // 4. Download File
        console.log(`Downloading file from Telegram: https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
        const fileBuffer = await downloadFile(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
        console.log(`File downloaded. Size: ${fileBuffer.length} bytes`);

        // 5. Upload to S3
        // Encode ChatID in the filename so the processor knows who to reply to.
        const s3Key = `input/${chatId}_${fileUniqueId}.${ext}`;
        console.log(`Uploading to S3: ${s3Key}`);
        await s3.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: s3Key,
            Body: fileBuffer
        }));
        console.log('Upload complete.');

        // 6. Start Transcribe Job
        const jobName = `${chatId}_${fileUniqueId}-${Date.now()}`;
        const outputKey = `output/${chatId}_${fileUniqueId}.json`;
        console.log(`Starting Transcribe job: ${jobName}, Output: ${outputKey}`);

        await transcribe.send(new StartTranscriptionJobCommand({
            TranscriptionJobName: jobName,
            // LanguageCode: 'he-IL', // REMOVED: Cannot set both LanguageCode and IdentifyLanguage
            IdentifyLanguage: true,
            Media: {
                MediaFileUri: `s3://${BUCKET_NAME}/${s3Key}`
            },
            OutputBucketName: BUCKET_NAME,
            OutputKey: outputKey
        }));
        console.log('Transcribe job started.');

        await sendTelegramMessage(chatId, "Transcription started... 🎙️");

        return { statusCode: 200, body: 'OK' };

    } catch (error) {
        console.error('Error in webhook:', error);
        return { statusCode: 500, body: error.message };
    }
};

// Helpers
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

function getTelegramFileInfo(fileId) {
    return new Promise((resolve, reject) => {
        https.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const json = JSON.parse(data);
                if (json.ok) resolve(json.result);
                else reject(new Error(json.description));
            });
        }).on('error', reject);
    });
}

function downloadFile(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const data = [];
            res.on('data', chunk => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
        }).on('error', reject);
    });
}
