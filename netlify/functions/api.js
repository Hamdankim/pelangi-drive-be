const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const Busboy = require("busboy");
const pdfParse = require("pdf-parse");
const PDFParser = require("pdf2json");
const XLSX = require("xlsx");
const { google } = require("googleapis");

const DEFAULT_ORIGINS = [
    "http://localhost",
    "http://127.0.0.1",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "https://pelangidrive.netlify.app",
];

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), "pelangi-temp");
const CREDENTIALS_DIR = process.env.CREDENTIALS_DIR || os.tmpdir();
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ROOT_FOLDER_ID =
    process.env.DRIVE_ROOT_FOLDER_ID ||
    process.env.DRIVE_FOLDER_ID ||
    "18c_Shx04J8MJOOSD-qv7iCnAoT-qHanb";

let driveClient;

function getAllowedOrigins() {
    const corsEnv = process.env.CORS_ORIGINS;
    if (!corsEnv) {
        return DEFAULT_ORIGINS;
    }
    return corsEnv
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
}

function getOrigin(headers) {
    return headers.origin || headers.Origin || "";
}

function buildCorsHeaders(origin) {
    const allowed = getAllowedOrigins();
    const headers = {
        "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Credentials": "true",
    };

    if (origin && allowed.includes(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Vary"] = "Origin";
    }

    return headers;
}

function withCors(response, origin) {
    return {
        ...response,
        headers: {
            ...(response.headers || {}),
            ...buildCorsHeaders(origin),
        },
    };
}

function parseJsonBody(event) {
    if (!event.body) {
        return {};
    }
    const raw = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf-8")
        : event.body;
    return JSON.parse(raw);
}

function safeFilename(filename) {
    const baseName = path.parse(filename || "").name.trim();
    const cleaned = baseName
        .replace(/\s+/g, " ")
        .replace(/[^A-Za-z0-9 ._-]/g, "")
        .trim();
    return cleaned || "file";
}

function resolveCredentialPath(fileName) {
    const localPath = path.join(process.cwd(), fileName);
    if (fs.existsSync(localPath)) {
        return localPath;
    }
    return path.join(CREDENTIALS_DIR, fileName);
}

function loadJsonFile(fileName) {
    const filePath = resolveCredentialPath(fileName);
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
}

function readJsonSafe(fileName) {
    try {
        loadJsonFile(fileName);
        return { ok: true, error: null };
    } catch (error) {
        return { ok: false, error: error && error.message ? error.message : "Invalid JSON" };
    }
}

function writeJsonFromEnv(envName, targetFile) {
    if (fs.existsSync(targetFile)) {
        return;
    }
    const raw = process.env[envName];
    if (!raw) {
        return;
    }

    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
        fs.writeFileSync(targetFile, trimmed, "utf-8");
        return;
    }

    try {
        const decoded = Buffer.from(trimmed, "base64");
        fs.writeFileSync(targetFile, decoded);
    } catch (error) {
        // Ignore invalid base64.
    }
}

function getDrive() {
    if (driveClient) {
        return driveClient;
    }

    writeJsonFromEnv("TOKEN_JSON_BASE64", path.join(CREDENTIALS_DIR, "token.json"));
    writeJsonFromEnv("CLIENT_SECRET_JSON_BASE64", path.join(CREDENTIALS_DIR, "client_secret.json"));

    const token = loadJsonFile("token.json");
    const clientSecret = loadJsonFile("client_secret.json");
    const config = clientSecret.installed || clientSecret.web || {};
    const oauth = new google.auth.OAuth2(config.client_id, config.client_secret);
    oauth.setCredentials(token);
    driveClient = google.drive({ version: "v3", auth: oauth });
    return driveClient;
}

function parseMultipart(event) {
    return new Promise((resolve, reject) => {
        const contentType = event.headers["content-type"] || event.headers["Content-Type"];
        if (!contentType) {
            reject(new Error("Missing Content-Type"));
            return;
        }

        const busboy = Busboy({ headers: { "content-type": contentType } });
        const fields = {};
        let fileBuffer;
        let filename = "";
        let mimeType = "";

        busboy.on("file", (fieldName, file, info) => {
            filename = info.filename || "";
            mimeType = info.mimeType || "";
            const chunks = [];
            file.on("data", (data) => chunks.push(data));
            file.on("end", () => {
                fileBuffer = Buffer.concat(chunks);
            });
        });

        busboy.on("field", (name, value) => {
            fields[name] = value;
        });

        busboy.on("error", reject);
        busboy.on("finish", () => resolve({ fields, fileBuffer, filename, mimeType }));

        const body = event.isBase64Encoded
            ? Buffer.from(event.body || "", "base64")
            : Buffer.from(event.body || "", "utf-8");
        busboy.end(body);
    });
}

async function detectFormat(buffer, filename) {
    if (filename && filename.toLowerCase().includes("neraca")) {
        return "neraca";
    }

    try {
        const parsed = await pdfParse(buffer);
        const text = parsed.text || "";
        if (text.includes("Laporan Neraca") || text.includes("Neraca Per")) {
            return "neraca";
        }
    } catch (error) {
        // Ignore detection errors and fall back to default.
    }

    return "default";
}

function extractRowsFromPage(page) {
    const rowMap = new Map();

    for (const item of page.Texts || []) {
        const yKey = Math.round(item.y * 10);
        const textParts = (item.R || []).map((part) => decodeURIComponent(part.T || ""));
        const text = textParts.join("");

        if (!rowMap.has(yKey)) {
            rowMap.set(yKey, []);
        }
        rowMap.get(yKey).push({ x: item.x, text });
    }

    const rows = [];
    const sortedKeys = Array.from(rowMap.keys()).sort((a, b) => a - b);
    for (const key of sortedKeys) {
        const entries = rowMap.get(key).sort((a, b) => a.x - b.x);
        rows.push(entries.map((entry) => entry.text));
    }

    return rows;
}

function convertPdfToExcel(buffer, outputPath) {
    return new Promise((resolve, reject) => {
        const pdfParser = new PDFParser();

        pdfParser.on("pdfParser_dataError", (error) => {
            reject(error.parserError || error);
        });

        pdfParser.on("pdfParser_dataReady", (pdfData) => {
            const rows = [];
            for (const page of pdfData.formImage.Pages || []) {
                rows.push(...extractRowsFromPage(page));
                rows.push([]);
            }

            const workbook = XLSX.utils.book_new();
            const sheet = XLSX.utils.aoa_to_sheet(rows);
            XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
            XLSX.writeFile(workbook, outputPath);
            resolve();
        });

        pdfParser.parseBuffer(buffer);
    });
}

async function convertNeraca(buffer, outputPath) {
    const apiKey = process.env.PDFCO_API_KEY;
    if (!apiKey) {
        throw new Error("PDFCO_API_KEY is not set");
    }

    const baseUrl = "https://api.pdf.co/v1";
    const filename = path.basename(outputPath).replace(/\.xlsx$/, ".pdf");
    const presignUrl = `${baseUrl}/file/upload/get-presigned-url?contenttype=application/pdf&name=${encodeURIComponent(filename)}`;

    const presignResponse = await fetch(presignUrl, {
        headers: { "x-api-key": apiKey },
    });
    if (!presignResponse.ok) {
        throw new Error("PDF.co presign failed");
    }

    const presignData = await presignResponse.json();
    if (presignData.error) {
        throw new Error(presignData.message || "PDF.co presign failed");
    }

    const uploadResponse = await fetch(presignData.presignedUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: buffer,
    });
    if (!uploadResponse.ok) {
        throw new Error("PDF.co upload failed");
    }

    const convertResponse = await fetch(`${baseUrl}/pdf/convert/to/xlsx`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
            url: presignData.url,
            async: false,
            name: path.basename(outputPath),
        }),
    });
    if (!convertResponse.ok) {
        throw new Error("PDF.co conversion failed");
    }

    const convertData = await convertResponse.json();
    if (convertData.error) {
        throw new Error(convertData.message || "PDF.co conversion failed");
    }

    const downloadResponse = await fetch(convertData.url);
    if (!downloadResponse.ok) {
        throw new Error("PDF.co download failed");
    }

    const arrayBuffer = await downloadResponse.arrayBuffer();
    fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
}

async function uploadToDrive(filePath, filename, parentFolderId) {
    const drive = getDrive();
    const parentId = parentFolderId || ROOT_FOLDER_ID;

    const response = await drive.files.create({
        requestBody: {
            name: filename,
            parents: [parentId],
        },
        media: {
            body: fs.createReadStream(filePath),
        },
        fields: "id",
    });

    return response.data.id;
}

async function listFilesInFolder(folderId) {
    const drive = getDrive();
    const targetId = folderId || ROOT_FOLDER_ID;
    const response = await drive.files.list({
        q: `'${targetId}' in parents and trashed=false`,
        fields: "files(id, name, mimeType, modifiedTime, size)",
    });
    return response.data.files || [];
}

async function getFileMetadata(fileId, fields) {
    const drive = getDrive();
    const response = await drive.files.get({
        fileId,
        fields,
    });
    return response.data;
}

async function downloadFile(fileId) {
    const drive = getDrive();
    const response = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" }
    );
    return Buffer.from(response.data);
}

async function renameFile(fileId, newName) {
    const drive = getDrive();
    await drive.files.update({
        fileId,
        requestBody: { name: newName },
        fields: "id, name",
    });
}

async function moveFile(fileId, targetFolderId) {
    const drive = getDrive();
    const targetId = targetFolderId || ROOT_FOLDER_ID;
    const fileInfo = await drive.files.get({ fileId, fields: "parents" });
    const previousParents = (fileInfo.data.parents || []).join(",");

    await drive.files.update({
        fileId,
        addParents: targetId,
        removeParents: previousParents,
        fields: "id, parents",
    });
}

async function deleteFile(fileId) {
    const drive = getDrive();
    await drive.files.delete({ fileId });
}

async function createFolder(name, parentId) {
    const drive = getDrive();
    const response = await drive.files.create({
        requestBody: {
            name,
            mimeType: "application/vnd.google-apps.folder",
            parents: [parentId || ROOT_FOLDER_ID],
        },
        fields: "id, name",
    });
    return response.data;
}

exports.handler = async (event) => {
    const origin = getOrigin(event.headers || {});
    let stage = "init";

    if (event.httpMethod === "OPTIONS") {
        return withCors({ statusCode: 204, body: "" }, origin);
    }

    const rawPath = event.path || "/";
    const routePath = rawPath.replace(/^\/\.netlify\/functions\/api/, "") || "/";

    try {
        if (routePath === "/upload" && event.httpMethod === "POST") {
            stage = "parse-multipart";
            const { fileBuffer, filename, mimeType, fields } = await parseMultipart(event);
            if (!fileBuffer || !filename) {
                return withCors(
                    { statusCode: 400, body: JSON.stringify({ detail: "File is required" }) },
                    origin
                );
            }
            if (mimeType !== "application/pdf" && !filename.toLowerCase().endsWith(".pdf")) {
                return withCors(
                    { statusCode: 400, body: JSON.stringify({ detail: "Only PDF allowed" }) },
                    origin
                );
            }

            stage = "prepare-files";
            const fileId = crypto.randomUUID();
            const baseName = safeFilename(filename);
            const excelName = `${baseName}.xlsx`;
            const pdfPath = path.join(UPLOAD_DIR, `${fileId}.pdf`);
            const excelPath = path.join(UPLOAD_DIR, `${fileId}.xlsx`);

            stage = "write-pdf";
            fs.writeFileSync(pdfPath, fileBuffer);

            stage = "detect-format";
            const formatType = await detectFormat(fileBuffer, filename);
            if (formatType === "neraca") {
                stage = "convert-neraca";
                await convertNeraca(fileBuffer, excelPath);
            } else {
                stage = "convert-default";
                await convertPdfToExcel(fileBuffer, excelPath);
            }

            stage = "upload-drive";
            const folderId = fields.folder_id || (event.queryStringParameters || {}).folder_id;
            const excelDriveId = await uploadToDrive(excelPath, excelName, folderId || undefined);

            stage = "cleanup";
            fs.unlinkSync(pdfPath);
            fs.unlinkSync(excelPath);

            return withCors(
                {
                    statusCode: 200,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        message: "Success",
                        excel_drive_id: excelDriveId,
                        format: formatType,
                    }),
                },
                origin
            );
        }

        if (routePath === "/list" && event.httpMethod === "GET") {
            const folderId = (event.queryStringParameters || {}).folder_id;
            const items = await listFilesInFolder(folderId || undefined);
            return withCors(
                {
                    statusCode: 200,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ items }),
                },
                origin
            );
        }

        if (routePath === "/health" && event.httpMethod === "GET") {
            writeJsonFromEnv("TOKEN_JSON_BASE64", path.join(CREDENTIALS_DIR, "token.json"));
            writeJsonFromEnv("CLIENT_SECRET_JSON_BASE64", path.join(CREDENTIALS_DIR, "client_secret.json"));
            const tokenPath = resolveCredentialPath("token.json");
            const clientPath = resolveCredentialPath("client_secret.json");
            const tokenStatus = readJsonSafe("token.json");
            const clientStatus = readJsonSafe("client_secret.json");
            const status = {
                env: {
                    tokenSet: Boolean(process.env.TOKEN_JSON_BASE64),
                    clientSet: Boolean(process.env.CLIENT_SECRET_JSON_BASE64),
                },
                files: {
                    tokenExists: fs.existsSync(tokenPath),
                    clientExists: fs.existsSync(clientPath),
                    tokenSize: fs.existsSync(tokenPath) ? fs.statSync(tokenPath).size : 0,
                    clientSize: fs.existsSync(clientPath) ? fs.statSync(clientPath).size : 0,
                },
                json: {
                    tokenReadable: tokenStatus.ok,
                    clientReadable: clientStatus.ok,
                    tokenError: tokenStatus.error,
                    clientError: clientStatus.error,
                },
            };
            return withCors(
                {
                    statusCode: 200,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(status),
                },
                origin
            );
        }

        if (routePath === "/folders-only" && event.httpMethod === "GET") {
            const rawItems = await listFilesInFolder(undefined);
            const folders = rawItems
                .filter((item) => item.mimeType === "application/vnd.google-apps.folder")
                .map((item) => ({ id: item.id, name: item.name }));
            return withCors(
                {
                    statusCode: 200,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ folders }),
                },
                origin
            );
        }

        if (routePath.startsWith("/download/") && event.httpMethod === "GET") {
            const fileId = routePath.split("/")[2];
            const metadata = await getFileMetadata(fileId, "id, name, mimeType");
            const fileBuffer = await downloadFile(fileId);
            const filename = (metadata.name || "file").replace(/"/g, "'");

            return withCors(
                {
                    statusCode: 200,
                    headers: {
                        "Content-Type": metadata.mimeType || "application/octet-stream",
                        "Content-Disposition": `attachment; filename="${filename}"`,
                    },
                    body: fileBuffer.toString("base64"),
                    isBase64Encoded: true,
                },
                origin
            );
        }

        if (routePath.startsWith("/files/") && event.httpMethod === "PATCH") {
            const parts = routePath.split("/").filter(Boolean);
            const fileId = parts[1];
            const action = parts[2];
            const payload = parseJsonBody(event);

            if (action === "rename") {
                const newName = (payload.name || "").trim();
                if (!newName) {
                    return withCors(
                        { statusCode: 400, body: JSON.stringify({ detail: "Name is required" }) },
                        origin
                    );
                }
                await renameFile(fileId, newName);
                return withCors(
                    { statusCode: 200, body: JSON.stringify({ message: "Renamed" }) },
                    origin
                );
            }

            if (action === "move") {
                await moveFile(fileId, payload.folder_id || undefined);
                return withCors(
                    { statusCode: 200, body: JSON.stringify({ message: "Moved" }) },
                    origin
                );
            }
        }

        if (routePath.startsWith("/files/") && event.httpMethod === "DELETE") {
            const fileId = routePath.split("/")[2];
            await deleteFile(fileId);
            return withCors(
                { statusCode: 200, body: JSON.stringify({ message: "Deleted" }) },
                origin
            );
        }

        if (routePath.startsWith("/files/") && routePath.endsWith("/open") && event.httpMethod === "GET") {
            const fileId = routePath.split("/")[2];
            const info = await getFileMetadata(fileId, "id, name, mimeType, webViewLink");
            const url = info.webViewLink;
            if (!url) {
                return withCors(
                    { statusCode: 404, body: JSON.stringify({ detail: "Open link not available" }) },
                    origin
                );
            }
            return withCors(
                { statusCode: 200, body: JSON.stringify({ url }) },
                origin
            );
        }

        if (routePath === "/folders" && event.httpMethod === "POST") {
            const payload = parseJsonBody(event);
            const name = (payload.name || "").trim();
            if (!name) {
                return withCors(
                    { statusCode: 400, body: JSON.stringify({ detail: "Folder name is required" }) },
                    origin
                );
            }
            const folder = await createFolder(name, payload.parent_id || undefined);
            return withCors(
                { statusCode: 200, body: JSON.stringify({ id: folder.id, name: folder.name }) },
                origin
            );
        }

        return withCors(
            { statusCode: 404, body: JSON.stringify({ detail: "Not found" }) },
            origin
        );
    } catch (error) {
        const message = error && error.message ? error.message : "Server error";
        const debug = process.env.DEBUG_ERRORS === "true";
        const payload = {
            detail: message,
            stage,
        };
        if (debug && error && error.stack) {
            payload.stack = error.stack;
        }
        return withCors(
            { statusCode: 500, body: JSON.stringify(payload) },
            origin
        );
    }
};
