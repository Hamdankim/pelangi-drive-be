from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload
from datetime import datetime
import base64
import io
import os

SCOPES = ['https://www.googleapis.com/auth/drive']


def _write_json_from_env(env_name, target_path):
    if os.path.exists(target_path):
        return
    payload = os.getenv(env_name)
    if not payload:
        return
    content = payload.strip()
    if content.startswith("{"):
        with open(target_path, "w", encoding="utf-8") as handle:
            handle.write(content)
        return
    try:
        decoded = base64.b64decode(content)
    except Exception:
        return
    with open(target_path, "wb") as handle:
        handle.write(decoded)


_write_json_from_env("TOKEN_JSON_BASE64", "token.json")
_write_json_from_env("CLIENT_SECRET_JSON_BASE64", "client_secret.json")

creds = Credentials.from_authorized_user_file('token.json', SCOPES)
drive_service = build('drive', 'v3', credentials=creds)

ROOT_FOLDER_ID = (
    os.getenv("DRIVE_ROOT_FOLDER_ID")
    or os.getenv("DRIVE_FOLDER_ID")
    or "18c_Shx04J8MJOOSD-qv7iCnAoT-qHanb"
)


def get_or_create_folder(name, parent_id):
    query = f"name='{name}' and mimeType='application/vnd.google-apps.folder' and '{parent_id}' in parents and trashed=false"
    results = drive_service.files().list(q=query, fields="files(id, name)").execute()
    folders = results.get('files', [])

    if folders:
        return folders[0]['id']

    folder_metadata = {
        'name': name,
        'mimeType': 'application/vnd.google-apps.folder',
        'parents': [parent_id]
    }

    folder = drive_service.files().create(
        body=folder_metadata,
        fields='id'
    ).execute()

    return folder.get('id')


def upload_to_drive(file_path, filename, parent_folder_id=None):
    parent_id = parent_folder_id or ROOT_FOLDER_ID
    file_metadata = {
        'name': filename,
        'parents': [parent_id]
    }

    media = MediaFileUpload(file_path, resumable=True)

    file = drive_service.files().create(
        body=file_metadata,
        media_body=media,
        fields='id'
    ).execute()

    return file.get('id')


def list_files_in_folder(folder_id=None):
    target_folder_id = folder_id or ROOT_FOLDER_ID
    query = f"'{target_folder_id}' in parents and trashed=false"

    results = drive_service.files().list(
        q=query,
        fields="files(id, name, mimeType, modifiedTime, size)"
    ).execute()

    return results.get('files', [])


def get_file_metadata(file_id):
    return drive_service.files().get(
        fileId=file_id,
        fields="id, name, mimeType"
    ).execute()


def get_file_open_link(file_id):
    return drive_service.files().get(
        fileId=file_id,
        fields="id, name, mimeType, webViewLink"
    ).execute()


def download_file(file_id):
    request = drive_service.files().get_media(fileId=file_id)
    file_stream = io.BytesIO()
    downloader = MediaIoBaseDownload(file_stream, request)

    done = False
    while not done:
        _, done = downloader.next_chunk()

    file_stream.seek(0)
    return file_stream


def rename_file(file_id, new_name):
    drive_service.files().update(
        fileId=file_id,
        body={"name": new_name},
        fields="id, name"
    ).execute()


def move_file(file_id, target_folder_id=None):
    target_id = target_folder_id or ROOT_FOLDER_ID
    file_info = drive_service.files().get(
        fileId=file_id,
        fields="parents"
    ).execute()

    previous_parents = ",".join(file_info.get("parents", []))

    drive_service.files().update(
        fileId=file_id,
        addParents=target_id,
        removeParents=previous_parents,
        fields="id, parents"
    ).execute()


def delete_file(file_id):
    drive_service.files().delete(fileId=file_id).execute()


def create_folder(name, parent_id=None):
    parent = parent_id or ROOT_FOLDER_ID
    folder_metadata = {
        'name': name,
        'mimeType': 'application/vnd.google-apps.folder',
        'parents': [parent]
    }

    folder = drive_service.files().create(
        body=folder_metadata,
        fields='id, name'
    ).execute()

    return folder
