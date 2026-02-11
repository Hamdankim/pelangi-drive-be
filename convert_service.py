import pdfplumber
from openpyxl import Workbook
import os

def convert_pdf_to_excel(pdf_path, output_path):
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
