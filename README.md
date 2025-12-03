# Serverless Telegram Transcription Bot

A 100% serverless, event-driven Telegram bot that transcribes voice notes using AWS Lambda and AWS Transcribe.

## Features

-   **Serverless**: Runs on AWS Lambda. Zero idle costs.
-   **Event-Driven**: Uses S3 events to trigger processing.
-   **Privacy-First**: Automatically deletes input audio and output transcripts after processing. No data is stored.
-   **Polyglot**: Automatically detects languages (English, Hebrew, Hindi, etc.).
-   **Secure**: Uses IAM Roles for internal permissions. No long-term access keys required.

## Architecture

1.  **User** sends a voice note to the Telegram Bot.
2.  **Webhook Lambda** receives the update, downloads the file, and uploads it to S3.
3.  **AWS Transcribe** job is triggered automatically.
4.  **Processor Lambda** is triggered when the transcription finishes (S3 Event).
5.  **Processor Lambda** sends the text back to the user on Telegram.
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

3.  **Create a `terraform.tfvars` file** (DO NOT commit this file):
    You can copy the example file:
    ```bash
    cp terraform.tfvars.example terraform.tfvars
    ```
    Then edit `terraform.tfvars` with your values:
    ```hcl
    telegram_bot_token = "YOUR_TELEGRAM_BOT_TOKEN"
    bucket_name        = "your-unique-bucket-name"
    
    # Allow a single user
    allowed_usernames  = "your_telegram_username"
    
    # OR allow multiple users (comma-separated)
    # allowed_usernames = "user1,user2,user3"
    ```

4.  **Deploy**:
    ```bash
    terraform apply
    ```
    Terraform will automatically register the webhook with Telegram.

## Usage

Just send a voice note to your bot! It will reply with the transcription.

## Cost

-   **AWS Lambda**: Free tier includes 400,000 GB-seconds per month.
-   **AWS Transcribe**: Free tier includes 60 minutes per month for 12 months.
-   **S3**: Negligible (files are deleted instantly).

## License

MIT
