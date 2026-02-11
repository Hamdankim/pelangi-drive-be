import os
from urllib.parse import quote

import pdfplumber
import requests
from openpyxl import Workbook


def convert_pdf_to_excel(pdf_path, output_path):
    """Default converter for table-based PDFs"""
    wb = Workbook()
    ws = wb.active
    row_index = 1

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            table = page.extract_table()
            if table:
                for row in table:
                    for col_index, cell in enumerate(row):
                        ws.cell(row=row_index, column=col_index+1, value=cell)
                    row_index += 1

    wb.save(output_path)

def convert_neraca(pdf_path, output_path):
    """Convert Neraca PDFs to XLSX using PDF.co API."""
    api_key = os.getenv("PDFCO_API_KEY")
    if not api_key:
        raise RuntimeError("PDFCO_API_KEY is not set")

    base_url = "https://api.pdf.co/v1"
    filename = os.path.basename(pdf_path)

    presign_url = (
        f"{base_url}/file/upload/get-presigned-url"
        f"?contenttype=application/pdf&name={quote(filename)}"
    )

    presign_response = requests.get(
        presign_url,
        headers={"x-api-key": api_key},
        timeout=30,
    )
    presign_response.raise_for_status()
    presign_data = presign_response.json()

    if presign_data.get("error"):
        raise RuntimeError(presign_data.get("message", "PDF.co presign failed"))

    upload_url = presign_data.get("presignedUrl")
    uploaded_file_url = presign_data.get("url")
    if not upload_url or not uploaded_file_url:
        raise RuntimeError("PDF.co presign response missing URLs")

    with open(pdf_path, "rb") as file_handle:
        upload_response = requests.put(
            upload_url,
            data=file_handle,
            headers={"Content-Type": "application/pdf"},
            timeout=60,
        )
    upload_response.raise_for_status()

    convert_payload = {
        "url": uploaded_file_url,
        "async": False,
        "name": os.path.basename(output_path),
    }
    convert_response = requests.post(
        f"{base_url}/pdf/convert/to/xlsx",
        json=convert_payload,
        headers={"x-api-key": api_key, "Content-Type": "application/json"},
        timeout=120,
    )
    convert_response.raise_for_status()
    convert_data = convert_response.json()

    if convert_data.get("error"):
        raise RuntimeError(convert_data.get("message", "PDF.co conversion failed"))

    output_url = convert_data.get("url")
    if not output_url:
        raise RuntimeError("PDF.co conversion did not return output URL")

    download_response = requests.get(output_url, timeout=120)
    download_response.raise_for_status()

    with open(output_path, "wb") as out_handle:
        out_handle.write(download_response.content)
