resource "aws_s3_bucket" "transcribe_bucket" {
  bucket = "diditranscribebot"
}

# --- IAM for Lambda ---

resource "aws_iam_role" "lambda_role" {
  name = "transcribe_bot_lambda_role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}



resource "aws_dynamodb_table" "usage_table" {
  name           = "transcription_usage"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "PK"

  attribute {
    name = "PK"
    type = "S"
  }
}

resource "aws_iam_role_policy" "lambda_policy" {
  name = "transcribe_bot_lambda_policy"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.transcribe_bucket.arn,
          "${aws_s3_bucket.transcribe_bucket.arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "transcribe:StartTranscriptionJob",
          "transcribe:GetTranscriptionJob",
          "transcribe:ListTranscriptionJobs",
          "transcribe:StartStreamTranscription"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:UpdateItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Scan"
        ]
        Resource = aws_dynamodb_table.usage_table.arn
      },
      {
        Effect = "Allow"
        Action = "lambda:InvokeFunction"
        Resource = "*"
      }
    ]
  })
}

# --- Lambda Functions ---

# Archive the code
data "archive_file" "webhook_zip" {
  type        = "zip"
  source_dir  = "${path.module}/src/webhook"
  output_path = "${path.module}/webhook.zip"
}

data "archive_file" "processor_zip" {
  type        = "zip"
  source_dir  = "${path.module}/src/processor"
  output_path = "${path.module}/processor.zip"
}

data "archive_file" "streaming_zip" {
  type        = "zip"
  source_dir  = "${path.module}/src/streaming"
  output_path = "${path.module}/streaming.zip"
}

# --- FFmpeg Layer ---

resource "null_resource" "download_ffmpeg" {
  provisioner "local-exec" {
    command = <<EOT
      mkdir -p ${path.module}/layers/ffmpeg/bin
      if [ ! -f "${path.module}/layers/ffmpeg/bin/ffmpeg" ]; then
        echo "Downloading FFmpeg..."
        curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o ffmpeg.tar.xz
        tar -xf ffmpeg.tar.xz
        mv ffmpeg-*-amd64-static/ffmpeg ${path.module}/layers/ffmpeg/bin/
        rm -rf ffmpeg.tar.xz ffmpeg-*-amd64-static
      fi
    EOT
  }
}

data "archive_file" "ffmpeg_layer_zip" {
  type        = "zip"
  source_dir  = "${path.module}/layers/ffmpeg"
  output_path = "${path.module}/ffmpeg_layer.zip"
  depends_on  = [null_resource.download_ffmpeg]
}

resource "aws_lambda_layer_version" "ffmpeg_layer" {
  filename            = data.archive_file.ffmpeg_layer_zip.output_path
  layer_name          = "ffmpeg_layer"
  description         = "Static FFmpeg binary"
  compatible_runtimes = ["nodejs18.x", "nodejs20.x", "nodejs22.x"]
  source_code_hash    = data.archive_file.ffmpeg_layer_zip.output_base64sha256
}



# Webhook Lambda
resource "aws_lambda_function" "webhook" {
  filename         = data.archive_file.webhook_zip.output_path
  function_name    = "transcribe_bot_webhook"
  role             = aws_iam_role.lambda_role.arn
  handler          = "index.handler"
  source_code_hash = data.archive_file.webhook_zip.output_base64sha256
  runtime          = "nodejs18.x"
  timeout          = 30

  environment {
    variables = {
      TELEGRAM_TOKEN          = var.telegram_bot_token
      BUCKET_NAME             = aws_s3_bucket.transcribe_bucket.id
      USAGE_TABLE             = aws_dynamodb_table.usage_table.name
      ADMIN_USERNAME          = var.telegram_admin_username
      STREAMING_FUNCTION_NAME = aws_lambda_function.streaming_processor.function_name
    }
  }
}

# Function URL for Webhook
resource "aws_lambda_function_url" "webhook_url" {
  function_name      = aws_lambda_function.webhook.function_name
  authorization_type = "NONE"
}

# Processor Lambda
resource "aws_lambda_function" "processor" {
  filename         = data.archive_file.processor_zip.output_path
  function_name    = "transcribe_bot_processor"
  role             = aws_iam_role.lambda_role.arn
  handler          = "index.handler"
  source_code_hash = data.archive_file.processor_zip.output_base64sha256
  runtime          = "nodejs22.x"
  timeout          = 30

  environment {
    variables = {
      TELEGRAM_TOKEN = var.telegram_bot_token
      USAGE_TABLE    = aws_dynamodb_table.usage_table.name
    }
  }
}

# Streaming Processor Lambda
resource "aws_lambda_function" "streaming_processor" {
  filename         = data.archive_file.streaming_zip.output_path
  function_name    = "transcribe_bot_streaming_processor"
  role             = aws_iam_role.lambda_role.arn
  handler          = "index.handler"
  source_code_hash = data.archive_file.streaming_zip.output_base64sha256
  runtime          = "nodejs20.x"
  timeout          = 900 # 15 minutes max
  layers           = [aws_lambda_layer_version.ffmpeg_layer.arn]

  environment {
    variables = {
      TELEGRAM_TOKEN = var.telegram_bot_token
      USAGE_TABLE    = aws_dynamodb_table.usage_table.name
    }
  }
}

# S3 Trigger for Processor
resource "aws_lambda_permission" "allow_s3" {
  statement_id  = "AllowExecutionFromS3"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.processor.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.transcribe_bucket.arn
}


resource "aws_s3_bucket_notification" "bucket_notification" {
  bucket = aws_s3_bucket.transcribe_bucket.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.processor.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "output/"
    filter_suffix       = ".json"
  }

  depends_on = [aws_lambda_permission.allow_s3]
}



# --- Telegram Webhook Automation ---



resource "null_resource" "telegram_webhook" {
  triggers = {
    # Always update the webhook when the function URL changes
    function_url = aws_lambda_function_url.webhook_url.function_url
    # Store token in triggers to be accessible during destroy
    telegram_token = var.telegram_bot_token
  }

  # Set the webhook on apply
  provisioner "local-exec" {
    command = "curl -s -X POST https://api.telegram.org/bot${var.telegram_bot_token}/setWebhook?url=${aws_lambda_function_url.webhook_url.function_url}"
  }

  # Remove the webhook on destroy
  provisioner "local-exec" {
    when    = destroy
    command = "curl -s -X POST https://api.telegram.org/bot${self.triggers.telegram_token}/deleteWebhook"
  }
}

