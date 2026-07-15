import express from 'express';
import WebTorrent from 'webtorrent';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Global WebTorrent client
const torrentClient = new WebTorrent();

// Tasks Store
// key: infoHash or randomId
// value: { id, name, status, progress, downloadSpeed, uploadSpeed, numPeers, length, downloaded, gdrive: { status, progress, error } }
const tasks = new Map();

// Global OAuth State
const authState = {
  authUrl: null,
  authenticated: false
};

// OAuth2 Client Setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GDRIVE_CLIENT_ID,
  process.env.GDRIVE_CLIENT_SECRET,
  process.env.GDRIVE_REDIRECT_URI
);

// Load existing token if saved
const TOKEN_PATH = path.join(__dirname, 'token.json');
if (fs.existsSync(TOKEN_PATH)) {
  try {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2Client.setCredentials(token);
    authState.authenticated = true;
    console.log('Google Drive OAuth token loaded from token.json');
  } catch (e) {
    console.error('Error reading token.json:', e.message);
  }
}

// Generate Auth URL if not authenticated
function updateAuthStatus() {
  if (!authState.authenticated) {
    const scopes = ['https://www.googleapis.com/auth/drive'];
    authState.authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent'
    });
  } else {
    authState.authUrl = null;
  }
}
updateAuthStatus();

// Endpoint to handle OAuth2 Callback
app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Authentication code is missing');
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    authState.authenticated = true;
    authState.authUrl = null;
    console.log('Successfully authenticated and saved token.');
    res.send('<h1>Xác thực Google Drive thành công! Bạn có thể đóng tab này và quay lại trang chính.</h1><script>setTimeout(() => window.close(), 2000);</script>');
  } catch (error) {
    console.error('Error retrieving access token:', error);
    res.status(500).send('Authentication failed: ' + error.message);
  }
});

// Helper to format bytes
function formatBytes(bytes, decimals = 2) {
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Helper to find or create the 'Films' folder on Google Drive
async function getOrCreateFilmsFolder(drive) {
  try {
    // 1. Search for folder 'Films' that is not trashed
    const response = await drive.files.list({
      q: "name = 'Films' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    if (response.data.files && response.data.files.length > 0) {
      console.log(`Found existing 'Films' folder with ID: ${response.data.files[0].id}`);
      return response.data.files[0].id;
    }

    // 2. Create 'Films' folder if not found
    console.log("Folder 'Films' not found. Creating a new one...");
    const fileMetadata = {
      name: 'Films',
      mimeType: 'application/vnd.google-apps.folder',
    };
    const folder = await drive.files.create({
      requestBody: fileMetadata,
      fields: 'id',
    });
    console.log(`Created new 'Films' folder with ID: ${folder.data.id}`);
    return folder.data.id;
  } catch (err) {
    console.error("Error finding/creating 'Films' folder:", err.message);
    return null;
  }
}

// Function to upload a file to Google Drive
async function uploadToGDrive(taskId, filePath, fileName) {
  if (!authState.authenticated) {
    throw new Error('Google Drive is not authenticated. Please log in first.');
  }

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const task = tasks.get(taskId);
  if (task) {
    task.status = 'uploading';
    task.gdrive = { status: 'uploading', progress: 0 };
  }

  try {
    const filmsFolderId = await getOrCreateFilmsFolder(drive);

    const fileMetadata = {
      name: fileName,
    };
    
    if (filmsFolderId) {
      fileMetadata.parents = [filmsFolderId];
    }

    const totalSize = fs.statSync(filePath).size;
    let uploadedBytes = 0;
    
    const progressStream = fs.createReadStream(filePath);
    progressStream.on('data', (chunk) => {
      uploadedBytes += chunk.length;
      const progress = Math.min(100, Math.round((uploadedBytes / totalSize) * 100));
      const currentTask = tasks.get(taskId);
      if (currentTask) {
        currentTask.gdrive.progress = progress;
      }
    });

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType: 'application/octet-stream',
        body: progressStream,
      },
      fields: 'id',
    });

    console.log(`[Task ${taskId}] File uploaded. ID:`, response.data.id);
    const finalTask = tasks.get(taskId);
    if (finalTask) {
      finalTask.status = 'completed';
      finalTask.gdrive.status = 'completed';
      finalTask.gdrive.progress = 100;
    }
  } catch (error) {
    console.error(`[Task ${taskId}] Google Drive Upload Error:`, error);
    const finalTask = tasks.get(taskId);
    if (finalTask) {
      finalTask.status = 'error';
      finalTask.gdrive = { status: 'error', error: error.message, progress: 0 };
    }
    throw error;
  }
}

// Start Torrent Download
app.post('/api/download', (req, res) => {
  const { magnetLink } = req.body;
  if (!magnetLink) {
    return res.status(400).json({ error: 'Magnet link is required' });
  }

  if (!authState.authenticated) {
    return res.status(401).json({ error: 'Vui lòng xác thực Google Drive trước khi tải!' });
  }

  const downloadDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir);
  }

  // Add to WebTorrent client
  try {
    torrentClient.add(magnetLink, { path: downloadDir }, (torrent) => {
      const taskId = torrent.infoHash;
      console.log('Torrent added:', torrent.name, 'with InfoHash/TaskId:', taskId);

      // Initialize Task Data
      tasks.set(taskId, {
        id: taskId,
        name: torrent.name || 'Fetching metadata...',
        status: 'downloading',
        progress: 0,
        downloadSpeed: '0 B/s',
        uploadSpeed: '0 B/s',
        numPeers: 0,
        length: 0,
        downloaded: 0,
        gdrive: { status: 'idle', progress: 0, error: null }
      });

      torrent.on('download', (bytes) => {
        const task = tasks.get(taskId);
        if (task) {
          task.name = torrent.name;
          task.progress = Math.round(torrent.progress * 100);
          task.downloadSpeed = formatBytes(torrent.downloadSpeed) + '/s';
          task.uploadSpeed = formatBytes(torrent.uploadSpeed) + '/s';
          task.numPeers = torrent.numPeers;
          task.length = torrent.length;
          task.downloaded = torrent.downloaded;
        }
      });

      torrent.on('done', async () => {
        console.log(`[Task ${taskId}] Torrent download finished!`);
        const task = tasks.get(taskId);
        if (task) {
          task.progress = 100;
          task.downloadSpeed = '0 B/s';
        }

        try {
          for (const file of torrent.files) {
            const filePath = path.join(downloadDir, file.path);
            console.log(`[Task ${taskId}] Uploading file ${file.name} to Google Drive...`);
            await uploadToGDrive(taskId, filePath, file.name);
            
            // Delete local file after upload
            try {
              fs.unlinkSync(filePath);
            } catch (e) {}
          }
        } catch (err) {
          console.error(`[Task ${taskId}] Error processing finished files:`, err);
        }
      });

      torrent.on('error', (err) => {
        console.error(`[Task ${taskId}] Torrent Error:`, err);
        const task = tasks.get(taskId);
        if (task) {
          task.status = 'error';
          task.error = err.message;
        }
      });
    });

    res.json({ success: true, message: 'Torrent download initiated' });
  } catch (err) {
    console.error('Error adding torrent:', err);
    res.status(500).json({ error: 'Không thể thêm link Torrent này. Hãy kiểm tra lại định dạng.' });
  }
});

// Cancel & Remove Torrent Route
app.delete('/api/download/:id', (req, res) => {
  const taskId = req.params.id;
  const task = tasks.get(taskId);

  if (!task) {
    return res.status(404).json({ error: 'Không tìm thấy tác vụ này' });
  }

  // 1. Find and destroy torrent from client
  const torrent = torrentClient.get(taskId);
  if (torrent) {
    console.log(`[Task ${taskId}] Destroying torrent on user request...`);
    try {
      torrentClient.remove(taskId);
    } catch (e) {
      console.error('Error removing torrent from client:', e.message);
    }
  }

  // 2. Remove temporary files
  const downloadDir = path.join(__dirname, 'downloads');
  if (torrent && torrent.files) {
    torrent.files.forEach(file => {
      const filePath = path.join(downloadDir, file.path);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`Deleted local file: ${filePath}`);
        }
      } catch (err) {
        console.error(`Error deleting file ${filePath}:`, err.message);
      }
    });
  }

  // 3. Remove from local Map
  tasks.delete(taskId);
  console.log(`[Task ${taskId}] Cancelled and cleaned up.`);
  res.json({ success: true, message: 'Đã hủy tải và dọn dẹp bộ nhớ tạm.' });
});


// SSE endpoint to push progress updates
app.get('/api/status', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const intervalId = setInterval(() => {
    const payload = {
      authenticated: authState.authenticated,
      authUrl: authState.authUrl,
      tasks: Array.from(tasks.values())
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }, 1000);

  req.on('close', () => {
    clearInterval(intervalId);
    res.end();
  });
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
