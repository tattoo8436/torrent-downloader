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

// WebTorrent client
let client = null;

// Download/Upload global status store
let currentStatus = {
  active: false,
  torrent: null, // { name, progress, downloadSpeed, uploadSpeed, numPeers, length, downloaded }
  gdrive: null,  // { status: 'idle'|'uploading'|'completed'|'error', progress: 0, speed: 0, error: null }
  authUrl: null, // If user needs to authenticate, we will provide OAuth Link
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
    currentStatus.authenticated = true;
    console.log('Google Drive OAuth token loaded from token.json');
  } catch (e) {
    console.error('Error reading token.json:', e.message);
  }
}

// Generate Auth URL if not authenticated
function updateAuthStatus() {
  if (!currentStatus.authenticated) {
    const scopes = ['https://www.googleapis.com/auth/drive'];
    currentStatus.authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent'
    });
  } else {
    currentStatus.authUrl = null;
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
    // Save tokens for future server restarts
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    currentStatus.authenticated = true;
    currentStatus.authUrl = null;
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

// Function to upload a file to Google Drive
async function uploadToGDrive(filePath, fileName) {
  if (!currentStatus.authenticated) {
    throw new Error('Google Drive is not authenticated. Please log in first.');
  }

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  currentStatus.gdrive = { status: 'uploading', progress: 0 };

  try {
    const fileMetadata = {
      name: fileName,
    };
    
    // Add folder destination if configured
    if (process.env.DRIVE_FOLDER_ID) {
      fileMetadata.parents = [process.env.DRIVE_FOLDER_ID];
    }

    const totalSize = fs.statSync(filePath).size;
    let uploadedBytes = 0;
    
    const progressStream = fs.createReadStream(filePath);
    progressStream.on('data', (chunk) => {
      uploadedBytes += chunk.length;
      const progress = Math.min(100, Math.round((uploadedBytes / totalSize) * 100));
      currentStatus.gdrive.progress = progress;
    });

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType: 'application/octet-stream',
        body: progressStream,
      },
      fields: 'id',
    });

    console.log('File uploaded to Google Drive. File ID:', response.data.id);
    currentStatus.gdrive.status = 'completed';
  } catch (error) {
    console.error('Google Drive Upload Error:', error);
    currentStatus.gdrive = { status: 'error', error: error.message, progress: 0 };
    throw error;
  }
}

// Start Torrent Download
app.post('/api/download', (req, res) => {
  const { magnetLink } = req.body;
  if (!magnetLink) {
    return res.status(400).json({ error: 'Magnet link is required' });
  }

  if (currentStatus.active) {
    return res.status(400).json({ error: 'Another torrent is already in progress' });
  }

  if (!currentStatus.authenticated) {
    return res.status(401).json({ error: 'Vui lòng xác thực Google Drive trước khi tải!' });
  }

  // Create temporary downloads directory inside the workspace
  const downloadDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir);
  }

  // Initialize WebTorrent Client
  client = new WebTorrent();

  currentStatus.active = true;
  currentStatus.torrent = {
    name: 'Fetching metadata...',
    progress: 0,
    downloadSpeed: '0 B/s',
    uploadSpeed: '0 B/s',
    numPeers: 0,
    length: 0,
    downloaded: 0,
  };
  currentStatus.gdrive = { status: 'idle', progress: 0, error: null };

  client.add(magnetLink, { path: downloadDir }, (torrent) => {
    console.log('Torrent added:', torrent.name);

    torrent.on('download', (bytes) => {
      currentStatus.torrent = {
        name: torrent.name,
        progress: Math.round(torrent.progress * 100),
        downloadSpeed: formatBytes(torrent.downloadSpeed) + '/s',
        uploadSpeed: formatBytes(torrent.uploadSpeed) + '/s',
        numPeers: torrent.numPeers,
        length: torrent.length,
        downloaded: torrent.downloaded,
      };
    });

    torrent.on('done', async () => {
      console.log('Torrent download finished!');
      currentStatus.torrent.progress = 100;
      currentStatus.torrent.downloadSpeed = '0 B/s';

      try {
        for (const file of torrent.files) {
          const filePath = path.join(downloadDir, file.path);
          console.log(`Uploading file ${file.name} to Google Drive...`);
          await uploadToGDrive(filePath, file.name);
          // Delete local file after upload to save space
          try {
            fs.unlinkSync(filePath);
          } catch (e) {}
        }
      } catch (err) {
        console.error('Error processing finished files:', err);
      } finally {
        // Clean up client
        client.destroy();
        client = null;
        currentStatus.active = false;
      }
    });

    torrent.on('error', (err) => {
      console.error('Torrent Error:', err);
      currentStatus.torrent.error = err.message;
      client.destroy();
      client = null;
      currentStatus.active = false;
    });
  });

  res.json({ success: true, message: 'Torrent download initiated' });
});

// SSE endpoint to push progress updates
app.get('/api/status', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const intervalId = setInterval(() => {
    res.write(`data: ${JSON.stringify(currentStatus)}\n\n`);
  }, 1000);

  req.on('close', () => {
    clearInterval(intervalId);
    res.end();
  });
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
