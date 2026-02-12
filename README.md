# pelangi-drive-be

FastAPI backend for PDF to Excel conversion and Google Drive management.

## Local Run

1. Install dependencies:

```bash
pip install -r requirements.txt
```

2. Create a .env file (optional) or export env vars:

```bash
export PDFCO_API_KEY=your_key
export DRIVE_ROOT_FOLDER_ID=your_folder_id
export CORS_ORIGINS=http://localhost,https://pelangidrive.netlify.app
```

3. Start the server:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

## Deploy to Render (Web Service)

### Build & Start

- Build Command:

```bash
pip install -r requirements.txt
```

- Start Command:

```bash
uvicorn main:app --host 0.0.0.0 --port $PORT
```

### Environment Variables

- PDFCO_API_KEY: required for Neraca conversion
- DRIVE_ROOT_FOLDER_ID: optional, overrides default root folder
- CORS_ORIGINS: comma-separated list of allowed origins
	- Example: https://pelangidrive.netlify.app

### Google Drive Credentials

This app needs these files at runtime:

- token.json
- client_secret.json

Recommended: store them as Render Secret Files and mount to the app root
so the paths remain the same.

## Deploy to Netlify Functions

This repo includes a serverless entry point at netlify/functions/api.js.

### Required settings (Netlify UI)

- Build command: npm install
- Functions directory: netlify/functions
- Environment variables:
	- PDFCO_API_KEY (required for Neraca conversion)
	- DRIVE_ROOT_FOLDER_ID or DRIVE_FOLDER_ID (optional)
	- CORS_ORIGINS (optional)
	- UPLOAD_DIR=/tmp/pelangi-temp (recommended)

### Google Drive credentials on Netlify

Netlify does not support secret files. For simplicity, this setup expects
token.json and client_secret.json to be committed to the repo.