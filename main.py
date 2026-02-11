from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import shutil
import os
import uuid
from datetime import datetime
import pdfplumber
from dotenv import load_dotenv
from convert_service import convert_pdf_to_excel, convert_neraca
from drive_service import (
    upload_to_drive,
    list_files_in_folder,
    get_file_metadata,
    download_file,
    rename_file,
    move_file,
    delete_file,
    get_file_open_link,
    create_folder
)
from utils import safe_filename

app = FastAPI()

load_dotenv()


class RenameRequest(BaseModel):
    name: str


class MoveRequest(BaseModel):
    folder_id: str | None = None


class CreateFolderRequest(BaseModel):
    name: str
    parent_id: str | None = None

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost",
        "http://127.0.0.1",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "temp"
os.makedirs(UPLOAD_DIR, exist_ok=True)


def detect_format(pdf_path, filename=None):
    """Detect PDF format (neraca vs default table-based)"""
    if filename and "neraca" in filename.lower():
        return "neraca"

    try:
        with pdfplumber.open(pdf_path) as pdf:
            text = pdf.pages[0].extract_text() if pdf.pages else ""
        
        # Check for Neraca indicators
        if "Laporan Neraca" in text or "Neraca Per" in text:
            return "neraca"
    except Exception:
        pass
    
    return "default"


@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...), folder_id: str | None = None):

    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="Only PDF allowed")

    file_id = str(uuid.uuid4())
    base_name = safe_filename(file.filename)
    pdf_name = f"{base_name}.pdf"
    excel_name = f"{base_name}.xlsx"
    pdf_path = os.path.join(UPLOAD_DIR, f"{file_id}.pdf")
    excel_path = os.path.join(UPLOAD_DIR, f"{file_id}.xlsx")

    with open(pdf_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # Detect format and convert accordingly
    format_type = detect_format(pdf_path, file.filename)
    
    if format_type == "neraca":
        convert_neraca(pdf_path, excel_path)
    else:
        convert_pdf_to_excel(pdf_path, excel_path)

    # Upload to Drive (Excel only)
    excel_drive_id = upload_to_drive(excel_path, excel_name, folder_id)

    # Cleanup local temp
    os.remove(pdf_path)
    os.remove(excel_path)

    return {
        "message": "Success",
        "excel_drive_id": excel_drive_id,
        "format": format_type
    }


@app.get("/list")
async def list_files(folder_id: str | None = None):
    raw_items = list_files_in_folder(folder_id)
    items = []

    for item in raw_items:
        items.append({
            "id": item.get("id"),
            "name": item.get("name"),
            "mimeType": item.get("mimeType"),
            "modifiedTime": item.get("modifiedTime"),
            "size": item.get("size"),
        })

    return {"items": items}


@app.get("/folders-only")
async def list_folders_only():
    raw_items = list_files_in_folder(None)
    folders = []

    for item in raw_items:
        if item.get("mimeType") == "application/vnd.google-apps.folder":
            folders.append({
                "id": item.get("id"),
                "name": item.get("name"),
            })

    return {"folders": folders}


@app.get("/download/{file_id}")
async def download_via_proxy(file_id: str):
    metadata = get_file_metadata(file_id)
    file_stream = download_file(file_id)
    filename = metadata.get("name", "file")
    media_type = metadata.get("mimeType", "application/octet-stream")

    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"'
    }

    return StreamingResponse(file_stream, media_type=media_type, headers=headers)


@app.patch("/files/{file_id}/rename")
async def rename_drive_file(file_id: str, payload: RenameRequest):
    new_name = payload.name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Name is required")

    rename_file(file_id, new_name)
    return {"message": "Renamed"}


@app.patch("/files/{file_id}/move")
async def move_drive_file(file_id: str, payload: MoveRequest):
    move_file(file_id, payload.folder_id)
    return {"message": "Moved"}


@app.delete("/files/{file_id}")
async def delete_drive_file(file_id: str):
    delete_file(file_id)
    return {"message": "Deleted"}


@app.get("/files/{file_id}/open")
async def open_drive_file(file_id: str):
    info = get_file_open_link(file_id)
    url = info.get("webViewLink")
    if not url:
        raise HTTPException(status_code=404, detail="Open link not available")
    return {"url": url}


@app.post("/folders")
async def create_drive_folder(payload: CreateFolderRequest):
    folder_name = payload.name.strip()
    if not folder_name:
        raise HTTPException(status_code=400, detail="Folder name is required")

    folder = create_folder(folder_name, payload.parent_id)
    return {
        "id": folder.get("id"),
        "name": folder.get("name")
    }
