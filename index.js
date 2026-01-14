import express from 'express';
import fetch from 'node-fetch';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import pino from 'pino';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import pn from 'awesome-phonenumber';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// GitHub Configuration
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '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';
const REPO_OWNER = 'obitomrdevapi-code';
const REPO_NAME = 'obito-pair-data';
const GITHUB_API = 'https://api.github.com';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create sessions directory if not exists
if (!existsSync(join(__dirname, 'sessions'))) {
    mkdirSync(join(__dirname, 'sessions'), { recursive: true });
}

// GitHub Helper Functions
async function githubRequest(endpoint, options = {}) {
    const url = `${GITHUB_API}${endpoint}`;
    const headers = {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'WhatsApp-Pairing-API',
        ...options.headers
    };

    const response = await fetch(url, {
        ...options,
        headers
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`GitHub API Error ${response.status}: ${error}`);
    }

    return response.json();
}

async function ensureRepoExists() {
    try {
        await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}`);
        console.log(`✅ Repository exists: ${REPO_NAME}`);
        return true;
    } catch (error) {
        if (error.message.includes('404')) {
            console.log(`📁 Creating repository: ${REPO_NAME}`);
            try {
                await githubRequest(`/user/repos`, {
                    method: 'POST',
                    body: JSON.stringify({
                        name: REPO_NAME,
                        private: true,
                        auto_init: true,
                        description: 'WhatsApp Sessions Storage'
                    })
                });
                console.log(`✅ Repository created: ${REPO_NAME}`);
                return true;
            } catch (createError) {
                console.error('❌ Failed to create repository:', createError.message);
                return false;
            }
        }
        console.error('❌ GitHub error:', error.message);
        return false;
    }
}

async function saveSessionToGitHub(phoneNumber, sessionData) {
    try {
        await ensureRepoExists();
        
        const fileName = `${phoneNumber}.json`;
        const filePath = `sessions/${fileName}`;
        const content = Buffer.from(JSON.stringify(sessionData, null, 2)).toString('base64');
        
        // Check if file exists
        let sha = null;
        try {
            const existing = await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`);
            sha = existing.sha;
        } catch (e) {
            // File doesn't exist, will create new
        }
        
        const response = await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`, {
            method: 'PUT',
            body: JSON.stringify({
                message: `Save session for ${phoneNumber}`,
                content: content,
                sha: sha,
                branch: 'main'
            })
        });
        
        console.log(`✅ Session saved to GitHub: ${fileName}`);
        return response.content.html_url;
    } catch (error) {
        console.error('❌ Error saving to GitHub:', error.message);
        throw error;
    }
}

async function getSessionFromGitHub(phoneNumber) {
    try {
        const fileName = `${phoneNumber}.json`;
        const filePath = `sessions/${fileName}`;
        
        const response = await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`);
        
        if (response.content) {
            const content = Buffer.from(response.content, 'base64').toString('utf-8');
            return JSON.parse(content);
        }
        
        return null;
    } catch (error) {
        if (error.message.includes('404')) {
            return null;
        }
        throw error;
    }
}

async function deleteSessionFromGitHub(phoneNumber) {
    try {
        const fileName = `${phoneNumber}.json`;
        const filePath = `sessions/${fileName}`;
        
        // Get file SHA first
        const fileInfo = await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`);
        
        await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`, {
            method: 'DELETE',
            body: JSON.stringify({
                message: `Delete session for ${phoneNumber}`,
                sha: fileInfo.sha,
                branch: 'main'
            })
        });
        
        console.log(`✅ Session deleted from GitHub: ${fileName}`);
        return true;
    } catch (error) {
        console.error('❌ Error deleting from GitHub:', error.message);
        return false;
    }
}

// WhatsApp Pairing Functions
async function generatePairingCode(phoneNumber) {
    try {
        // Clean phone number
        let num = phoneNumber.replace(/[^0-9]/g, '');
        
        // Validate phone number
        const phone = pn('+' + num);
        if (!phone.isValid()) {
            throw new Error('Invalid phone number');
        }
        
        num = phone.getNumber('e164').replace('+', '');
        
        // Check for existing session
        const existingSession = await getSessionFromGitHub(num);
        if (existingSession) {
            return {
                success: true,
                message: 'Session already exists',
                phoneNumber: num,
                hasExistingSession: true,
                sessionUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/main/sessions/${num}.json`
            };
        }
        
        // Generate new pairing code
        const { default: baileys } = await import('@whiskeysockets/baileys');
        const { useMultiFileAuthState, fetchLatestBaileysVersion, makeWASocket, Browsers, makeCacheableSignalKeyStore } = baileys;
        
        const sessionDir = join(__dirname, 'sessions', num);
        if (!existsSync(sessionDir)) {
            mkdirSync(sessionDir, { recursive: true });
        }
        
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }),
            browser: Browsers.windows('Chrome'),
            connectTimeoutMs: 60000,
        });
        
        return new Promise((resolve, reject) => {
            let timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for connection'));
            }, 30000);
            
            sock.ev.on('connection.update', async (update) => {
                const { connection, qr } = update;
                
                if (qr) {
                    clearTimeout(timeout);
                    await sock.ws.close();
                    
                    resolve({
                        success: true,
                        message: 'QR code generated',
                        qrCode: qr,
                        phoneNumber: num,
                        sessionDir: sessionDir
                    });
                }
                
                if (connection === 'open') {
                    clearTimeout(timeout);
                    
                    // Save session to GitHub
                    const credsFile = join(sessionDir, 'creds.json');
                    if (existsSync(credsFile)) {
                        const sessionData = JSON.parse(readFileSync(credsFile, 'utf8'));
                        const githubUrl = await saveSessionToGitHub(num, sessionData);
                        
                        // Clean local files
                        try {
                            unlinkSync(credsFile);
                        } catch (e) {}
                        
                        resolve({
                            success: true,
                            message: 'Session connected and saved',
                            phoneNumber: num,
                            githubUrl: githubUrl,
                            sessionSaved: true
                        });
                    }
                    
                    await sock.ws.close();
                }
                
                if (connection === 'close') {
                    clearTimeout(timeout);
                    reject(new Error('Connection closed'));
                }
            });
            
            // Request pairing code if needed
            setTimeout(async () => {
                if (!sock.authState.creds.registered) {
                    try {
                        const code = await sock.requestPairingCode(num);
                        const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                        
                        clearTimeout(timeout);
                        
                        resolve({
                            success: true,
                            message: 'Pairing code generated',
                            pairingCode: formattedCode,
                            phoneNumber: num,
                            rawCode: code
                        });
                    } catch (error) {
                        reject(error);
                    }
                }
            }, 3000);
        });
        
    } catch (error) {
        console.error('Error generating pairing code:', error);
        throw error;
    }
}

// API Routes
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'WhatsApp Pairing API',
        version: '2.0.0',
        endpoints: {
            generate: 'GET /api/pair?num=PHONE_NUMBER',
            check: 'GET /api/check?num=PHONE_NUMBER',
            delete: 'DELETE /api/session?num=PHONE_NUMBER'
        },
        github: `https://github.com/${REPO_OWNER}/${REPO_NAME}`
    });
});

app.get('/api/pair', async (req, res) => {
    try {
        const { num } = req.query;
        
        if (!num) {
            return res.status(400).json({
                success: false,
                error: 'Phone number is required',
                example: '/api/pair?num=15551234567'
            });
        }
        
        console.log(`📱 Generating pairing for: ${num}`);
        
        const result = await generatePairingCode(num);
        
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            ...result
        });
        
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: 'Failed to generate pairing code'
        });
    }
});

app.get('/api/check', async (req, res) => {
    try {
        const { num } = req.query;
        
        if (!num) {
            return res.status(400).json({
                success: false,
                error: 'Phone number is required'
            });
        }
        
        // Clean phone number
        let cleanNum = num.replace(/[^0-9]/g, '');
        const phone = pn('+' + cleanNum);
        
        if (!phone.isValid()) {
            return res.status(400).json({
                success: false,
                error: 'Invalid phone number format'
            });
        }
        
        cleanNum = phone.getNumber('e164').replace('+', '');
        
        const session = await getSessionFromGitHub(cleanNum);
        
        res.json({
            success: true,
            phoneNumber: cleanNum,
            hasSession: !!session,
            sessionExists: !!session,
            githubUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/main/sessions/${cleanNum}.json`,
            lastChecked: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.delete('/api/session', async (req, res) => {
    try {
        const { num } = req.query;
        
        if (!num) {
            return res.status(400).json({
                success: false,
                error: 'Phone number is required'
            });
        }
        
        // Clean phone number
        let cleanNum = num.replace(/[^0-9]/g, '');
        const phone = pn('+' + cleanNum);
        
        if (!phone.isValid()) {
            return res.status(400).json({
                success: false,
                error: 'Invalid phone number format'
            });
        }
        
        cleanNum = phone.getNumber('e164').replace('+', '');
        
        const deleted = await deleteSessionFromGitHub(cleanNum);
        
        res.json({
            success: deleted,
            message: deleted ? 'Session deleted successfully' : 'Failed to delete session',
            phoneNumber: cleanNum,
            deletedAt: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/sessions', async (req, res) => {
    try {
        const sessions = await githubRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/sessions`);
        
        res.json({
            success: true,
            count: sessions.length,
            sessions: sessions.map(session => ({
                name: session.name,
                size: session.size,
                downloadUrl: session.download_url,
                lastModified: new Date(session.updated_at).toISOString()
            })),
            totalSessions: sessions.length
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        github: {
            repo: `${REPO_OWNER}/${REPO_NAME}`,
            connected: !!GITHUB_TOKEN
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📁 GitHub Repo: ${REPO_OWNER}/${REPO_NAME}`);
    console.log(`🔗 API Endpoint: http://localhost:${PORT}/api/pair?num=YOUR_NUMBER`);
});
