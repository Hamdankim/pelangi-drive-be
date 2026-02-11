import os
import re


def safe_filename(filename: str) -> str:
	base_name = os.path.splitext(filename or "")[0].strip()
	base_name = re.sub(r"\s+", " ", base_name).strip()
	base_name = re.sub(r"[^A-Za-z0-9 ._-]", "", base_name)
	return base_name or "file"
