import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import { Octokit } from '@octokit/rest';

const router = express.Router();
const GITHUB_TOKEN = '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';
const REPO_OWNER = 'obitomrdevapi-code';
const REPO_NAME = 'obito-pair-data';
const octokit = new Octokit({ auth: GITHUB_TOKEN });

async function ensureRepoExists() {
    try {
        await octokit.repos.get({
            owner: REPO_OWNER,
            repo: REPO_NAME
        });
    } catch (error) {
        if (error.status === 404) {
            await octokit.repos.createForAuthenticatedUser({
                name: REPO_NAME,
                private: true,
                auto_init: true
            });
            console.log(`✅ Created new repository: ${REPO_NAME}`);
        } else {
            throw error;
        }
    }
}

async function saveSessionToGitHub(phoneNumber, sessionData) {
    await ensureRepoExists();
    
    const fileName = `${phoneNumber}-creds.json`;
    const filePath = `sessions/${fileName}`;
    
    try {
        try {
            const existingFile = await octokit.repos.getContent({
                owner: REPO_OWNER,
                repo: REPO_NAME,
                path: filePath
            });
            
            await octokit.repos.createOrUpdateFileContents({
                owner: REPO_OWNER,
                repo: REPO_NAME,
                path: filePath,
                message: `Update session for ${phoneNumber}`,
                content: Buffer.from(JSON.stringify(sessionData, null, 2)).toString('base64'),
                sha: existingFile.data.sha
            });
        } catch (error) {
            if (error.status === 404) {
                await octokit.repos.createOrUpdateFileContents({
                    owner: REPO_OWNER,
                    repo: REPO_NAME,
                    path: filePath,
                    message: `Create session for ${phoneNumber}`,
                    content: Buffer.from(JSON.stringify(sessionData, null, 2)).toString('base64')
                });
            } else {
                throw error;
            }
        }
        
        console.log(`✅ Session saved to GitHub: ${filePath}`);
        return filePath;
    } catch (error) {
        console.error('❌ Error saving to GitHub:', error);
        throw error;
    }
}

async function getSessionFromGitHub(phoneNumber) {
    try {
        const fileName = `${phoneNumber}-creds.json`;
        const filePath = `sessions/${fileName}`;
        
        const response = await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: filePath
        });
        
        const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
        return JSON.parse(content);
    } catch (error) {
        if (error.status === 404) {
            return null;
        }
        throw error;
    }
}

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    let dirs = './' + (num || `session`);

    await removeFile(dirs);

    num = num.replace(/[^0-9]/g, '');

    const phone = pn('+' + num);
    if (!phone.isValid()) {
        if (!res.headersSent) {
            return res.status(400).send({ code: 'Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK, 84987654321 for Vietnam, etc.) without + or spaces.' });
        }
        return;
    }
    num = phone.getNumber('e164').replace('+', '');

    async function initiateSession() {
        const existingSession = await getSessionFromGitHub(num);
        if (existingSession) {
            console.log(`📂 Found existing session for ${num} in GitHub`);
            
            if (!fs.existsSync(dirs)) {
                fs.mkdirSync(dirs, { recursive: true });
            }
            
            fs.writeFileSync(`${dirs}/creds.json`, JSON.stringify(existingSession, null, 2));
        }

        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version, isLatest } = await fetchLatestBaileysVersion();
            let KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });

            KnightBot.ev.on('creds.update', async (creds) => {
                await saveCreds();
                
                const sessionData = JSON.parse(fs.readFileSync(`${dirs}/creds.json`, 'utf8'));
                await saveSessionToGitHub(num, sessionData);
            });

            KnightBot.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, isNewLogin, isOnline } = update;

                if (connection === 'open') {
                    console.log("✅ Connected successfully!");
                    
                    try {
                        const sessionData = JSON.parse(fs.readFileSync(`${dirs}/creds.json`, 'utf8'));
                        await saveSessionToGitHub(num, sessionData);
                        
                        console.log("📱 Sending session info to user...");
                        
                        const sessionKnight = fs.readFileSync(dirs + '/creds.json');
                        const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                        
                        await KnightBot.sendMessage(userJid, {
                            document: sessionKnight,
                            mimetype: 'application/json',
                            fileName: 'creds.json'
                        });
                        console.log("📄 Session file sent successfully");

                        await KnightBot.sendMessage(userJid, {
                            image: { url: 'https://img.youtube.com/vi/-oz_u1iMgf8/maxresdefault.jpg' },
                            caption: `🎬 *KnightBot MD V2.0 Full Setup Guide!*\n\n🚀 Bug Fixes + New Commands + Fast AI Chat\n📺 Watch Now: https://youtu.be/NjOipI2AoMk`
                        });
                        console.log("🎬 Video guide sent successfully");

                        await KnightBot.sendMessage(userJid, {
                            text: `⚠️Do not share this file with anybody⚠️\n\n📁 Your session has been securely backed up to GitHub\n\n┌┤✑  Thanks for using Knight Bot\n│└────────────┈ ⳹        \n│©2025 Mr Unique Hacker \n└─────────────────┈ ⳹\n\n`
                        });
                        console.log("⚠️ Warning message sent successfully");

                        console.log("🧹 Cleaning up local session...");
                        await delay(1000);
                        removeFile(dirs);
                        console.log("✅ Local session cleaned up");
                        console.log("🎉 Process completed successfully!");
                        
                    } catch (error) {
                        console.error("❌ Error:", error);
                        removeFile(dirs);
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via pair code");
                }

                if (isOnline) {
                    console.log("📶 Client is online");
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;

                    if (statusCode === 401) {
                        console.log("❌ Logged out from WhatsApp. Session removed from GitHub.");
                        try {
                            const fileName = `${num}-creds.json`;
                            const filePath = `sessions/${fileName}`;
                            
                            await octokit.repos.deleteFile({
                                owner: REPO_OWNER,
                                repo: REPO_NAME,
                                path: filePath,
                                message: `Remove session for ${num} (logged out)`,
                                sha: (await octokit.repos.getContent({
                                    owner: REPO_OWNER,
                                    repo: REPO_NAME,
                                    path: filePath
                                })).data.sha
                            });
                        } catch (error) {
                            console.error('Error removing session from GitHub:', error);
                        }
                    } else {
                        console.log("🔁 Connection closed — restarting...");
                        initiateSession();
                    }
                }
            });

            if (!KnightBot.authState.creds.registered) {
                await delay(3000);
                num = num.replace(/[^\d+]/g, '');
                if (num.startsWith('+')) num = num.substring(1);

                try {
                    let code = await KnightBot.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    if (!res.headersSent) {
                        console.log({ num, code });
                        await res.send({ code });
                    }
                } catch (error) {
                    console.error('Error requesting pairing code:', error);
                    if (!res.headersSent) {
                        res.status(503).send({ code: 'Failed to get pairing code. Please check your phone number and try again.' });
                    }
                }
            }
        } catch (err) {
            console.error('Error initializing session:', err);
            if (!res.headersSent) {
                res.status(503).send({ code: 'Service Unavailable' });
            }
        }
    }

    await initiateSession();
});

process.on('uncaughtException', (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (e.includes("Stream Errored")) return;
    if (e.includes("Stream Errored (restart required)")) return;
    if (e.includes("statusCode: 515")) return;
    if (e.includes("statusCode: 503")) return;
    console.log('Caught exception: ', err);
});

export default router;
