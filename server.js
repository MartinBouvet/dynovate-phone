const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const nodemailer = require('nodemailer');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();

// ============================================
// CONFIGURATION HYBRIDE : OLLAMA + GROQ
// ============================================
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = 'nchapman/ministral-8b-instruct-2410:8b';

const groq = new Groq({ 
    apiKey: process.env.GROQ_API_KEY || 'gsk_dummy_key_for_init'
});

let USE_OLLAMA = false; // Sera défini au démarrage

// Test connexion Ollama au démarrage
// Test connexion Ollama au démarrage
async function testOllama() {
    try {
        // Test simple : vérifier que Ollama répond
        const response = await axios.get(`${OLLAMA_URL}/api/tags`, { 
            timeout: 3000 
        });
        
        // Vérifier que notre modèle existe
        const models = response.data.models || [];
        const hasModel = models.some(m => m.name === OLLAMA_MODEL);
        
        if (hasModel) {
            console.log('✅ Ollama LOCAL détecté et activé');
            return true;
        } else {
            console.log(`⚠️  Modèle ${OLLAMA_MODEL} non trouvé`);
            return false;
        }
    } catch (error) {
        console.log('⚠️  Ollama non disponible, bascule sur Groq Cloud');
        return false;
    }
}

// ============================================
// CONFIGURATION TTS (VOIX)
// ============================================
// Pour l'instant on utilise Twilio Alice
// On ajoutera Piper + ta voix après
const USE_CUSTOM_TTS = false; // À activer plus tard

// ============================================
// CONFIGURATION EMAIL
// ============================================
let emailTransporter = null;
console.log('\n🔍 DIAGNOSTIC EMAIL:');
console.log(`EMAIL_USER: ${process.env.EMAIL_USER || 'NON CONFIGURÉ'}`);
console.log(`EMAIL_PASS: ${process.env.EMAIL_PASS ? '[CONFIGURÉ]' : '[MANQUANT]'}`);

if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
        emailTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        
        emailTransporter.verify((error) => {
            if (error) {
                console.error('❌ ERREUR EMAIL:', error.message);
            } else {
                console.log('✅ EMAIL CONFIGURÉ');
            }
        });
    } catch (error) {
        console.error('❌ Erreur création transporter:', error.message);
    }
}

// ============================================
// STOCKAGE CONVERSATIONS
// ============================================
const conversations = new Map();
const userProfiles = new Map();
const processedCalls = new Set();

// Middleware
app.use(express.urlencoded({ extended: false }));

// ============================================
// CONTEXTE DYNOVATE
// ============================================
const DYNOVATE_CONTEXT = `Tu es Dynophone, assistant commercial chez Dynovate.

SOLUTIONS (présenter les 4 ensemble si demandé):
1. IA Email: Analyse et tri automatique des emails, réponses automatiques. Gain de 70% de temps.
2. IA Téléphonique: Gestion d'appels 24/7 comme cette conversation.
3. IA Réseaux sociaux: Réponses automatiques sur réseaux sociaux 24h/24.
4. IA Chatbot: Assistant intelligent sur site web en temps réel.

RÈGLES STRICTES:
1. Réponses TRÈS courtes: Maximum 2 phrases
2. Une seule question de relance maximum
3. Si client dit "merci" ou "au revoir" → "Merci pour votre appel, à bientôt !" et STOPPER
4. Ton professionnel mais chaleureux

IMPORTANT: Sois concis et naturel.`;

// ============================================
// FONCTION HYBRIDE : OLLAMA OU GROQ
// ============================================
async function generateAIResponse(messages, context = '') {
    const startTime = Date.now();
    
    try {
        if (USE_OLLAMA) {
            // ====== OLLAMA LOCAL (rapide) ======
            let fullPrompt = `${DYNOVATE_CONTEXT}\n\n${context}\n\n`;
            
            messages.forEach(msg => {
                if (msg.role === 'user') {
                    fullPrompt += `Client: ${msg.content}\n`;
                } else {
                    fullPrompt += `Dynophone: ${msg.content}\n`;
                }
            });
            
            fullPrompt += `\nDynophone (réponds en maximum 2 phrases courtes):`;
            
            const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
                model: OLLAMA_MODEL,
                prompt: fullPrompt,
                stream: false,
                options: {
                    temperature: 0.3,
                    num_predict: 100,
                    stop: ["\n\n", "Client:", "Dynophone:"]
                }
            });
            
            const aiResponse = response.data.response.trim();
            const duration = Date.now() - startTime;
            
            console.log(`⚡ [OLLAMA LOCAL] (${duration}ms): "${aiResponse}"`);
            return aiResponse;
            
        } else {
            // ====== GROQ CLOUD (fallback) ======
            const systemPrompt = `${DYNOVATE_CONTEXT}\n\n${context}\n\nIMPORTANT: Réponds en maximum 2 phrases courtes et complètes.`;
            
            const completion = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...messages.slice(-6)
                ],
                temperature: 0.3
            });
            
            const aiResponse = completion.choices[0].message.content.trim();
            const duration = Date.now() - startTime;
            
            console.log(`☁️  [GROQ CLOUD] (${duration}ms): "${aiResponse}"`);
            return aiResponse;
        }
        
    } catch (error) {
        console.error(`❌ Erreur IA: ${error.message}`);
        
        // Si Ollama échoue, tenter Groq en fallback
        if (USE_OLLAMA && !error.message.includes('Groq')) {
            console.log('🔄 Tentative de fallback sur Groq...');
            USE_OLLAMA = false;
            return generateAIResponse(messages, context);
        }
        
        throw error;
    }
}

// ============================================
// ENDPOINTS TWILIO
// ============================================

app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;
    
    if (callStatus === 'completed' || callStatus === 'no-answer' || callStatus === 'busy') {
        console.log(`🏁 Appel terminé: ${callSid}`);
        setTimeout(() => cleanupCall(callSid), 1000);
        res.sendStatus(200);
        return;
    }
    
    console.log(`📞 APPEL: ${callSid} - ${req.body.From}`);
    
    if (!userProfiles.has(callSid)) {
        userProfiles.set(callSid, {
            phone: req.body.From,
            startTime: Date.now(),
            interactions: 0
        });
        conversations.set(callSid, []);
    }
    
    const welcomeText = "Bonjour, Dynophone de Dynovate. Comment puis-je vous aider ?";
    
    // Pour l'instant voix Twilio (on changera après)
    twiml.say({ voice: 'alice', language: 'fr-FR' }, welcomeText);
    
    twiml.gather({
        input: 'speech',
        language: 'fr-FR',
        speechTimeout: 2,
        timeout: 5,
        action: '/process-speech',
        method: 'POST',
        speechModel: 'experimental_conversations',
        enhanced: true
    });
    
    twiml.redirect('/voice');
    
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/process-speech', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const speechResult = req.body.SpeechResult || '';
    const callSid = req.body.CallSid;
    
    if (!speechResult.trim()) {
        twiml.gather({
            input: 'speech',
            language: 'fr-FR',
            speechTimeout: 2,
            timeout: 4,
            action: '/process-speech',
            method: 'POST'
        }).say({ voice: 'alice', language: 'fr-FR' }, 'Je vous écoute.');
        
        twiml.redirect('/voice');
        res.type('text/xml');
        res.send(twiml.toString());
        return;
    }
    
    console.log(`🎤 ${callSid}: "${speechResult}"`);
    
    let userProfile = userProfiles.get(callSid) || {};
    
    try {
        const shouldEndCall = /merci|au revoir|c'est tout|bonne journée/i.test(speechResult);
        
        const conversation = conversations.get(callSid) || [];
        userProfile.interactions = (userProfile.interactions || 0) + 1;
        userProfile.lastInteractionTime = Date.now();
        userProfiles.set(callSid, userProfile);
        
        // Détecter email
        const extractedEmail = extractEmail(speechResult);
        if (extractedEmail && !userProfile.email) {
            userProfile.email = extractedEmail;
            console.log(`📧 Email capturé: ${userProfile.email}`);
        }
        
        // Détecter RDV
        if (/rendez-vous|rdv|démo|rencontrer/i.test(speechResult)) {
            userProfile.rdvRequested = true;
        }
        
        conversation.push({ role: 'user', content: speechResult });
        
        let aiResponse = "";
        
        if (shouldEndCall) {
            aiResponse = "Merci pour votre appel et à bientôt !";
            console.log(`🏁 Fin d'appel: ${callSid}`);
        } else {
            // Contexte additionnel
            let contextAddition = "";
            if (userProfile.email) contextAddition += `\nEmail client: ${userProfile.email}`;
            if (userProfile.sector) contextAddition += `\nSecteur: ${userProfile.sector}`;
            
            // Appel IA hybride
            aiResponse = await generateAIResponse(conversation.slice(-6), contextAddition);
            
            // Nettoyage
            aiResponse = aiResponse.replace(/^\d+\.\s*/gm, '');
            aiResponse = aiResponse.replace(/^[-•*]\s*/gm, '');
            aiResponse = aiResponse.replace(/\n+/g, ' ').trim();
        }
        
        conversation.push({ role: 'assistant', content: aiResponse });
        conversations.set(callSid, conversation);
        
        extractUserInfo(callSid, speechResult, aiResponse);
        
        // Réponse vocale
        twiml.say({ voice: 'alice', language: 'fr-FR' }, aiResponse);
        
        if (shouldEndCall) {
            twiml.pause({ length: 1 });
            twiml.hangup();
            setTimeout(() => cleanupCall(callSid), 1000);
        } else {
            twiml.gather({
                input: 'speech',
                language: 'fr-FR',
                speechTimeout: 2,
                timeout: 6,
                action: '/process-speech',
                method: 'POST',
                speechModel: 'experimental_conversations',
                enhanced: true
            });
            twiml.redirect('/voice');
        }
        
        res.type('text/xml');
        res.send(twiml.toString());
        
    } catch (error) {
        console.error(`❌ Erreur ${callSid}:`, error);
        twiml.say({ voice: 'alice', language: 'fr-FR' }, 
            'Désolé, un problème technique. Un expert vous rappellera.');
        twiml.hangup();
        res.type('text/xml');
        res.send(twiml.toString());
        setTimeout(() => cleanupCall(callSid), 1000);
    }
});

// ============================================
// FONCTIONS UTILITAIRES
// ============================================

function extractEmail(speech) {
    if (!speech) return null;
    
    let clean = speech.toLowerCase().trim();
    clean = clean.replace(/arobase|at/gi, "@");
    clean = clean.replace(/point|dot/gi, ".");
    
    const emailRegex = /[a-z0-9][a-z0-9._%+-]{2,}@[a-z0-9][a-z0-9.-]*\.[a-z]{2,4}/gi;
    const matches = clean.match(emailRegex);
    
    if (matches && matches.length > 0) {
        const email = matches[0];
        if (email.includes('@') && email.includes('.') && email.length > 5) {
            return email;
        }
    }
    
    return null;
}

function extractUserInfo(callSid, speech, response) {
    const profile = userProfiles.get(callSid) || {};
    const lowerSpeech = speech.toLowerCase();
    
    const sectors = [
        { keywords: ['restaurant', 'café', 'bar', 'hôtel'], name: 'Restauration' },
        { keywords: ['immobilier', 'agence', 'location'], name: 'Immobilier' },
        { keywords: ['commerce', 'boutique', 'magasin'], name: 'Commerce' },
        { keywords: ['médical', 'médecin', 'cabinet', 'santé'], name: 'Santé' },
        { keywords: ['garage', 'automobile', 'voiture'], name: 'Automobile' }
    ];
    
    for (const sector of sectors) {
        if (sector.keywords.some(keyword => lowerSpeech.includes(keyword))) {
            profile.sector = sector.name;
            break;
        }
    }
    
    userProfiles.set(callSid, profile);
}

async function cleanupCall(callSid) {
    if (processedCalls.has(callSid)) {
        return;
    }
    
    const profile = userProfiles.get(callSid);
    const conversation = conversations.get(callSid) || [];
    
    if (profile && profile.interactions > 0 && profile.phone) {
        processedCalls.add(callSid);
        
        const duration = Math.round((Date.now() - profile.startTime) / 1000);
        console.log(`📊 Fin appel - ${duration}s, ${profile.interactions} échanges`);
        
        await sendCallSummary(profile, conversation);
        
        const leadType = (profile.email || profile.rdvRequested) ? 'LEAD QUALIFIÉ' : 'PROSPECT';
        console.log(`💰 ${leadType}: RDV=${profile.rdvRequested || false}`);
    }
    
    conversations.delete(callSid);
    userProfiles.delete(callSid);
}

async function sendCallSummary(profile, conversation) {
    const fs = require('fs');
    const path = require('path');
    
    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    
    const timestamp = Date.now();
    const phoneClean = profile.phone.replace(/[^0-9]/g, '');
    const duration = Math.round((Date.now() - profile.startTime) / 1000);
    
    const readableContent = `
📞 RAPPORT DYNOVATE - ${new Date().toLocaleString('fr-FR')}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📱 CONTACT
• Téléphone: ${profile.phone}
• Email: ${profile.email || '❌ NON COLLECTÉ'}
• Secteur: ${profile.sector || 'Non identifié'}

📅 RENDEZ-VOUS
• Demandé: ${profile.rdvRequested ? 'OUI ✅' : 'NON ❌'}

⏱️ STATISTIQUES
• Durée: ${duration}s (${Math.round(duration/60)}min)
• Échanges: ${profile.interactions || 0}

📋 CONVERSATION
${conversation.map((msg, index) => 
    `${index + 1}. ${msg.role === 'user' ? '👤 CLIENT' : '🤖 DYNOPHONE'}: ${msg.content}`
).join('\n\n')}
    `;
    
    const txtFileName = `call_${phoneClean}_${timestamp}.txt`;
    const txtFilePath = path.join(reportsDir, txtFileName);
    
    try {
        fs.writeFileSync(txtFilePath, readableContent);
        console.log(`✅ Rapport: ${txtFileName}`);
    } catch (e) {
        console.error('❌ Erreur rapport:', e.message);
    }
    
    if (emailTransporter) {
        try {
            const leadStatus = (profile.email || profile.rdvRequested) ? '📅 RDV DEMANDÉ' : 'PROSPECT';
            
            await emailTransporter.sendMail({
                from: `"Dynophone" <${process.env.EMAIL_USER}>`,
                to: process.env.REPORT_EMAIL || process.env.EMAIL_USER,
                subject: `[${leadStatus}] Appel ${profile.phone}`,
                text: readableContent
            });
            
            console.log(`✅ EMAIL ENVOYÉ`);
        } catch (error) {
            console.error(`❌ ERREUR EMAIL:`, error.message);
        }
    }
}

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', async (req, res) => {
    res.json({ 
        status: 'OK',
        timestamp: new Date().toISOString(),
        features: {
            llm: USE_OLLAMA ? 'Ollama (local)' : 'Groq (cloud)',
            ollama_available: USE_OLLAMA,
            email: !!emailTransporter
        },
        stats: {
            activeConversations: conversations.size,
            userProfiles: userProfiles.size
        }
    });
});

// ============================================
// DÉMARRAGE
// ============================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    // Tester Ollama
    USE_OLLAMA = await testOllama();
    
    const llmInfo = USE_OLLAMA 
        ? `Ollama LOCAL (${OLLAMA_MODEL})` 
        : `Groq CLOUD (llama-3.3-70b)`;
    
    console.log(`
🚀 DYNOVATE ASSISTANT IA - VERSION HYBRIDE
⚡ Port: ${PORT}
    
🤖 LLM: ${llmInfo}
🔊 Voix: Twilio Alice (temporaire)
📧 Email: ${emailTransporter ? 'CONFIGURÉ ✅' : 'NON CONFIGURÉ ❌'}

${USE_OLLAMA ? '💚 Mode DÉVELOPPEMENT (Ollama rapide)' : '☁️  Mode PRODUCTION (Groq cloud)'}
    `);
});

// Nettoyage automatique
setInterval(() => {
    const now = Date.now();
    const idleTimeout = 2 * 60 * 1000;
    
    for (const [callSid, profile] of userProfiles.entries()) {
        const timeSinceLastInteraction = now - (profile.lastInteractionTime || profile.startTime);
        
        if (timeSinceLastInteraction > idleTimeout && profile.interactions > 0) {
            console.log(`🔌 Détection raccrochage: ${callSid}`);
            cleanupCall(callSid);
        }
    }
}, 30 * 1000);