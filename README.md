# Serverless Telegram Transcription Bot

A 100% serverless, event-driven Telegram bot that transcribes voice notes using AWS Lambda and AWS Transcribe.

## Features

-   **Serverless**: Runs on AWS Lambda. Zero idle costs.
-   **Event-Driven**: Uses S3 events to trigger processing.
-   **Privacy-First**: Automatically deletes input audio and output transcripts after processing. No data is stored.
-   **Polyglot**: Automatically detects languages (English, Hebrew, Hindi, etc.).
-   **Secure**: Uses IAM Roles for internal permissions. No long-term access keys required.
-   **Usage Tracking**: Tracks total duration and stats per user in DynamoDB.
-   **Admin Commands**: Manage allowed users dynamically via Telegram commands.

## Architecture

1.  **User** sends a voice note to the Telegram Bot.
2.  **Webhook Lambda** receives the update, checks permissions (DynamoDB), downloads the file, and uploads it to S3.
3.  **AWS Transcribe** job is triggered automatically.
4.  **Processor Lambda** is triggered when the transcription finishes (S3 Event).
5.  **Processor Lambda** sends the text back to the user on Telegram, followed by a stats summary.
6.  **Cleanup**: Both the audio file and the transcript JSON are deleted from S3.

## Prerequisites

-   **AWS Account**
-   **Terraform** installed
-   **Telegram Bot Token** (from @BotFather)

## Setup

1.  **Clone the repository**:
    ```bash
    git clone <your-repo-url>
    cd <your-repo-folder>
    ```

2.  **Configure AWS Credentials**:
    Ensure you have an AWS account and have configured your credentials so Terraform can access it.
    ```bash
    aws configure
    ```
    *You will need your Access Key ID and Secret Access Key.*

3.  **Initialize Terraform**:
    ```bash
    terraform init
    ```

4.  **Create a `terraform.tfvars` file** (DO NOT commit this file):
    You can copy the example file:
    ```bash
    cp terraform.tfvars.example terraform.tfvars
    ```
    Then edit `terraform.tfvars` with your values:
    ```hcl
    telegram_bot_token      = "YOUR_TELEGRAM_BOT_TOKEN"
    telegram_admin_username = "your_username" # Without @
    bucket_name             = "your-unique-bucket-name"
    ```

5.  **Deploy**:
    ```bash
    terraform apply
    ```
    Terraform will automatically register the webhook with Telegram.

## Usage

### Admin Commands
As the admin (configured in `terraform.tfvars`), you can manage who can use the bot:
-   `/add <username>`: Add a user to the allowlist.
-   `/revoke <username>`: Remove a user.
-   `/list`: Show all allowed users.
-   `/stats`: View global usage statistics.
-   `/help`: Show available commands.

### Transcription
Just send a voice note to your bot! It will reply with:
1.  The transcription text.
2.  A stats summary (e.g., `⏱️ 45s (en-US) | 📈 Total: 120m 30s`).

## Cost Estimation

This project is designed to be extremely low cost, often free for personal use.

*   **AWS Lambda**: Free Tier includes **400,000 GB-seconds per month**.
    *   *Estimate*: For personal use (e.g., 100 voice notes/month), you will stay well within the Free Tier.
    *   *Overages*: ~$0.20 per 1 million requests.
*   **AWS Transcribe**: Free Tier includes **60 minutes per month** for the first 12 months.
    *   *Estimate*: If you transcribe < 60 mins/month, it's free.
    *   *Overages*: ~$0.024 per minute (~$1.44 per hour).
*   **Amazon DynamoDB**: Free Tier includes **25 GB of storage** and 25 RCU/WCU.
    *   *Estimate*: Storing simple usage stats is negligible. You will likely never pay for this.
*   **Amazon S3**: Standard rates apply.
    *   *Estimate*: Since files are deleted immediately after processing, storage costs are effectively zero. You only pay for API requests (negligible).

**Total Estimated Cost**: **$0.00/month** (within Free Tier limits).

## License

MIT
