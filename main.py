from fastapi import FastAPI, UploadFile, File, HTTPException
import shutil
import os
import uuid
from convert_service import convert_pdf_to_excel
from drive_service import upload_to_drive

app = FastAPI()

UPLOAD_DIR = "temp"
os.makedirs(UPLOAD_DIR, exist_ok=True)

@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):

    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="Only PDF allowed")

    file_id = str(uuid.uuid4())
    pdf_path = os.path.join(UPLOAD_DIR, f"{file_id}.pdf")
    excel_path = os.path.join(UPLOAD_DIR, f"{file_id}.xlsx")

    with open(pdf_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # Convert
    convert_pdf_to_excel(pdf_path, excel_path)

    # Upload to Drive
    pdf_drive_id = upload_to_drive(pdf_path, f"{file_id}.pdf")
    excel_drive_id = upload_to_drive(excel_path, f"{file_id}.xlsx")

    # Cleanup local temp
    os.remove(pdf_path)
    os.remove(excel_path)

    return {
        "message": "Success",
        "pdf_drive_id": pdf_drive_id,
        "excel_drive_id": excel_drive_id
    }
