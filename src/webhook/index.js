const https = require('https');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { TranscribeClient, StartTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const s3 = new S3Client();
const transcribe = new TranscribeClient();
const ddbClient = new DynamoDBClient();
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BUCKET_NAME = process.env.BUCKET_NAME;
const USAGE_TABLE = process.env.USAGE_TABLE;
const ADMIN_USER = process.env.ADMIN_USERNAME;

exports.handler = async (event) => {
    console.log('Received event:', JSON.stringify(event));

    try {
        const body = JSON.parse(event.body);

        // Handle Telegram "pre-checkout" or other service messages if needed
        if (!body.message) {
            console.log('Received event with no message body. Ignoring.');
            return { statusCode: 200, body: 'OK' };
        }

        const chatId = body.message.chat.id;
        const username = body.message.chat.username;
        const firstName = body.message.chat.first_name;
        const text = body.message.text;

        console.log(`Received message from User: ${username} (${firstName}), ChatID: ${chatId}`);

        // 0. Update User Info in DynamoDB (if not a command)
        if (USAGE_TABLE && !text?.startsWith('/')) {
            try {
                await ddbDocClient.send(new UpdateCommand({
                    TableName: USAGE_TABLE,
                    Key: { PK: `USER#${chatId}` },
                    UpdateExpression: "SET username = :u, first_name = :f",
                    ExpressionAttributeValues: {
                        ":u": username || "unknown",
                        ":f": firstName || "unknown"
                    }
                }));
            } catch (e) {
                console.error(`Failed to update user info:`, e);
            }
        }

        // 1. Fetch Allowlist
        let allowedUsers = new Set([ADMIN_USER, 'fabiankuypers']); // Default
        if (USAGE_TABLE) {
            try {
                const config = await ddbDocClient.send(new GetCommand({
                    TableName: USAGE_TABLE,
                    Key: { PK: 'CONFIG' }
                }));
                if (config.Item && config.Item.allowed_users) {
                    allowedUsers = new Set(config.Item.allowed_users);
                }
            } catch (e) {
                console.error("Failed to fetch allowlist:", e);
            }
        }

        // 2. Handle Commands
        if (text && text.startsWith('/')) {
            const parts = text.split(' ');
            const command = parts[0];
            const arg = parts[1] ? parts[1].replace('@', '') : null;

            if (command === '/add' && username === ADMIN_USER && arg) {
                allowedUsers.add(arg);
                await updateAllowlist(Array.from(allowedUsers));
                await sendTelegramMessage(chatId, `User @${arg} added.`);
                return { statusCode: 200, body: 'OK' };
            }

            if (command === '/revoke' && username === ADMIN_USER && arg) {
                if (allowedUsers.has(arg)) {
                    allowedUsers.delete(arg);
                    await updateAllowlist(Array.from(allowedUsers));
                    await sendTelegramMessage(chatId, `User @${arg} revoked.`);
                } else {
                    await sendTelegramMessage(chatId, `User @${arg} is not in the allowlist.`);
                }
                return { statusCode: 200, body: 'OK' };
            }

            if (command === '/list' && username === ADMIN_USER) {
                const list = Array.from(allowedUsers).map(u => `@${u}`).join('\n');
                await sendTelegramMessage(chatId, `📝 *Allowed Users:*\n${list}`);
                return { statusCode: 200, body: 'OK' };
            }

            if (command === '/help' && username === ADMIN_USER) {
                const helpMsg = `🤖 *Admin Commands*\n` +
                    `/add <username> - Add user\n` +
                    `/revoke <username> - Remove user\n` +
                    `/list - Show allowed users\n` +
                    `/stats - Show global stats`;
                await sendTelegramMessage(chatId, helpMsg);
                return { statusCode: 200, body: 'OK' };
            }

            if (command === '/stats') {
                // Allow anyone in the allowlist to check stats
                if (allowedUsers.has(username)) {
                    await sendStats(chatId);
                } else {
                    await sendTelegramMessage(chatId, "Unauthorized.");
                }
                return { statusCode: 200, body: 'OK' };
            }
        }

        // 3. Check permissions
        if (!allowedUsers.has(username)) {
            await sendTelegramMessage(chatId, "Sorry, you need to ask the owner for permission to use this bot (Transcription costs a bit of $$)");
            return { statusCode: 200, body: 'Unauthorized' };
        }

        // 4. Check for voice/audio
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
async function updateAllowlist(users) {
    if (!USAGE_TABLE) return;
    try {
        await ddbDocClient.send(new UpdateCommand({
            TableName: USAGE_TABLE,
            Key: { PK: 'CONFIG' },
            UpdateExpression: "SET allowed_users = :u",
            ExpressionAttributeValues: { ":u": users }
        }));
    } catch (e) {
        console.error("Failed to update allowlist:", e);
    }
}

async function sendStats(chatId) {
    if (!USAGE_TABLE) return;
    try {
        // Fetch Global
        const globalRes = await ddbDocClient.send(new GetCommand({
            TableName: USAGE_TABLE,
            Key: { PK: 'GLOBAL' }
        }));
        const global = globalRes.Item || {};

        // Scan Users (for top users)
        const scanRes = await ddbDocClient.send(new ScanCommand({
            TableName: USAGE_TABLE,
            FilterExpression: "begins_with(PK, :prefix)",
            ExpressionAttributeValues: { ":prefix": "USER#" }
        }));
        const users = scanRes.Items || [];

        // Format
        const formatDur = (sec) => {
            const m = Math.floor(sec / 60);
            const s = Math.floor(sec % 60);
            return `${m}m ${s}s`;
        };
        const getVal = (obj, key) => obj[key] ? Number(obj[key]) : 0;

        let msg = `📊 *Global Stats*\n`;
        msg += `⏱️ Total Time: ${formatDur(getVal(global, 'total_seconds'))}\n`;
        msg += `💾 Total Data: ${getVal(global, 'total_kbytes').toLocaleString()} KB\n`;
        msg += `📝 Transcriptions: ${getVal(global, 'total_transcriptions')}\n\n`;

        msg += `🌍 *Languages*\n`;
        const langs = global.seconds_by_language || {};
        for (const [lang, sec] of Object.entries(langs)) {
            const count = global.transcriptions_by_language?.[lang] || 0;
            msg += `- ${lang}: ${formatDur(sec)} (${count})\n`;
        }

        msg += `\n👥 *Top Users*\n`;
        // Sort by duration desc
        users.sort((a, b) => getVal(b, 'total_seconds') - getVal(a, 'total_seconds'));
        for (const u of users.slice(0, 5)) { // Top 5
            const name = u.username ? `@${u.username}` : (u.first_name || 'Unknown');
            msg += `- ${name}: ${formatDur(getVal(u, 'total_seconds'))} (${getVal(u, 'total_kbytes')} KB)\n`;
        }

        await sendTelegramMessage(chatId, msg);

    } catch (e) {
        console.error("Failed to send stats:", e);
        await sendTelegramMessage(chatId, "Failed to retrieve stats.");
    }
}

function sendTelegramMessage(chatId, text) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' });
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
