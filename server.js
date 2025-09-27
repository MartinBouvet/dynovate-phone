const express = require('express');
const twilio = require('twilio');
const Groq = require('groq-sdk');
const axios = require('axios');
const nodemailer = require('nodemailer');

const app = express();

// Configuration
const groq = new Groq({ 
    apiKey: process.env.GROQ_API_KEY || 'gsk_dummy_key_for_init'
});

// FLAG pour activer/désactiver ElevenLabs facilement
const USE_ELEVENLABS = process.env.USE_ELEVENLABS === 'true';
const ELEVENLABS_API_KEY = USE_ELEVENLABS ? process.env.ELEVENLABS_API_KEY : null;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'ThT5KcBeYPX3keUQqHPh';

// Configuration email SIMPLE
let emailTransporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
        emailTransporter = nodemailer.createTransporter({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        console.log('📧 Email configuré');
    } catch (error) {
        console.error('❌ Erreur email:', error.message);
        emailTransporter = null;
    }
}

// Stockage global
global.audioQueue = {};
global.streamingResponses = {};

// Stockage conversations
const conversations = new Map();
const userProfiles = new Map();
const responseCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// Middleware
app.use(express.urlencoded({ extended: false }));

// Contexte Dynovate CORRIGÉ - Fin d'appel propre
const DYNOVATE_CONTEXT = `Tu es Dynophone, assistant commercial chez Dynovate, entreprise d'IA pour la relation client.

SOLUTIONS:
- IA Email: tri et réponses automatiques
- IA Téléphonique: gestion d'appels 24/7 (comme notre conversation actuelle)
- IA Réseaux sociaux: réponses sur tous les canaux
- IA Chatbot: assistant pour sites web

RÈGLES CONVERSATION:
1. Répondre aux questions posées naturellement
2. Proposer RDV seulement si pertinent
3. Si RDV demandé → demander date/heure précise
4. Une fois RDV confirmé → ne plus en reparler

GESTION FIN D'APPEL:
- Si client dit "merci", "au revoir", "c'est tout" → répondre "Merci pour votre appel et à bientôt ! FIN_APPEL"
- NE PAS demander "Avez-vous d'autres questions ?" après avoir dit au revoir
- Conclure directement avec FIN_APPEL

IMPORTANT:
- Réponses naturelles et fluides
- Pas de redondance dans les questions
- Conclusion propre de l'appel`;

// Fonction d'extraction d'email simple
function extractEmail(speech) {
    if (!speech) return null;
    
    let clean = speech.toLowerCase().trim();
    clean = clean.replace(/(c'est|mon mail|mon email|mon adresse)/gi, " ");
    clean = clean.replace(/ arobase | at /gi, "@");
    clean = clean.replace(/ point | dot /gi, ".");
    
    const emailRegex = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,4}/gi;
    const matches = clean.match(emailRegex);
    
    if (matches && matches.length > 0) {
        const email = matches[0];
        if (email.includes('@') && email.includes('.') && 
            email.length > 5 && email.length < 50) {
            return email;
        }
    }
    
    return null;
}

// ENDPOINT AUDIO ELEVENLABS STREAMING
app.get('/generate-audio/:token', async (req, res) => {
    const token = req.params.token;
    const text = global.audioQueue[token];
    
    if (!text) {
        return res.status(404).send('Audio not found');
    }
    
    if (!ELEVENLABS_API_KEY) {
        return res.status(500).send('ElevenLabs not configured');
    }
    
    try {
        const startTime = Date.now();
        
        const voiceId = ELEVENLABS_VOICE_ID === '21m00Tcm4TlvDq8ikWAM' 
            ? 'ThT5KcBeYPX3keUQqHPh'
            : ELEVENLABS_VOICE_ID;
        
        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            data: {
                text: text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: {
                    stability: 0.6,
                    similarity_boost: 0.8,
                    style: 0.0,
                    use_speaker_boost: false
                },
                optimize_streaming_latency: 4
            },
            responseType: 'stream'
        });
        
        delete global.audioQueue[token];
        
        res.set({
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
            'Transfer-Encoding': 'chunked'
        });
        
        response.data.pipe(res);
        
        console.log(`✅ Audio streamé en ${Date.now() - startTime}ms`);
        
    } catch (error) {
        console.error(`❌ Erreur: ${error.message}`);
        delete global.audioQueue[token];
        res.status(500).send('Error');
    }
});

// Route principale
app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    
    console.log(`📞 APPEL: ${callSid} - ${req.body.From}`);
    
    userProfiles.set(callSid, {
        phone: req.body.From,
        startTime: Date.now(),
        interactions: 0
    });
    conversations.set(callSid, []);
    
    // Message d'accueil avec ElevenLabs
    if (ELEVENLABS_API_KEY) {
        try {
            const welcomeText = "Bonjour! Dynophone de Dynovate, comment puis-je vous aider?";
            const audioToken = Buffer.from(`welcome:${callSid}:${Date.now()}`).toString('base64url');
            
            global.audioQueue[audioToken] = welcomeText;
            
            const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
                ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                : `https://${req.headers.host}`;
            
            twiml.play(`${baseUrl}/generate-audio/${audioToken}`);
            
        } catch (error) {
            twiml.say({ voice: 'alice', language: 'fr-FR' }, 
                'Bonjour! Dynophone de Dynovate, comment puis-je vous aider?');
        }
    } else {
        twiml.say({ voice: 'alice', language: 'fr-FR' }, 
            'Bonjour! Dynophone de Dynovate, comment puis-je vous aider?');
    }
    
    const gather = twiml.gather({
        input: 'speech',
        language: 'fr-FR',
        speechTimeout: 1,
        timeout: 4,
        action: '/process-speech',
        method: 'POST',
        speechModel: 'experimental_conversations',
        enhanced: true,
        profanityFilter: false
    });
    
    gather.say({ voice: 'alice', language: 'fr-FR' }, 'Je vous écoute.');
    
    twiml.redirect('/voice');
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// Traitement speech SIMPLIFIÉ
app.post('/process-speech', async (req, res) => {
    const startTime = Date.now();
    const twiml = new twilio.twiml.VoiceResponse();
    const speechResult = req.body.SpeechResult || '';
    const callSid = req.body.CallSid;
    
    if (!speechResult.trim()) {
        return sendFallbackResponse(res, twiml, callSid);
    }
    
    console.log(`🎤 ${callSid}: "${speechResult}"`);
    
    // Récupérer/créer le profil
    let userProfile = userProfiles.get(callSid) || {};
    
    try {
        // DÉTECTION EMAIL
        const extractedEmail = extractEmail(speechResult);
        if (extractedEmail && !userProfile.email) {
            userProfile.email = extractedEmail;
            console.log(`📧 Email capturé: ${userProfile.email}`);
            userProfiles.set(callSid, userProfile);
        }
        
        // DÉTECTION RDV
        if (/rendez-vous|rdv|démo|rencontrer|lundi|mardi|mercredi|jeudi|vendredi|\d+h/i.test(speechResult)) {
            userProfile.rdvRequested = true;
            const dateMatch = speechResult.match(/(lundi|mardi|mercredi|jeudi|vendredi|demain|après-demain).*?(\d+h|\d+:\d+)?/i);
            if (dateMatch) {
                userProfile.rdvDate = dateMatch[0];
                console.log(`📅 RDV demandé: ${userProfile.rdvDate}`);
            }
        }
        
        // PRÉPARER CONVERSATION
        const conversation = conversations.get(callSid) || [];
        userProfile.interactions = (userProfile.interactions || 0) + 1;
        userProfiles.set(callSid, userProfile);
        
        let contextAddition = "";
        if (userProfile.email) contextAddition += `\nEmail client: ${userProfile.email}`;
        if (userProfile.sector) contextAddition += `\nSecteur: ${userProfile.sector}`;
        if (userProfile.rdvDate) contextAddition += `\nRDV souhaité: ${userProfile.rdvDate}`;
        
        conversation.push({ role: 'user', content: speechResult });
        
        // APPEL GROQ
        let aiResponse = "";
        
        try {
            const completion = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { 
                        role: 'system', 
                        content: DYNOVATE_CONTEXT + contextAddition 
                    },
                    ...conversation.slice(-6)
                ],
                temperature: 0.4,
                max_tokens: 80,
                stream: false
            });
            
            aiResponse = completion.choices[0].message.content.trim();
            
            // POST-TRAITEMENT
            if (!aiResponse.match(/[.!?]$/)) {
                const sentences = aiResponse.split(/[.!?]/);
                if (sentences.length > 1) {
                    aiResponse = sentences.slice(0, -1).join('.') + '.';
                } else {
                    aiResponse = aiResponse + '.';
                }
            }
            
            // LOGIQUE RDV SIMPLE
            if (userProfile.rdvRequested && userProfile.rdvDate && !userProfile.rdvConfirmed) {
                userProfile.rdvConfirmed = true;
                aiResponse = `Parfait ! Votre rendez-vous est confirmé pour ${userProfile.rdvDate}. Nous vous recontacterons pour vous envoyer le lien de réservation.`;
            }
            
            // GESTION FIN D'APPEL CORRIGÉE
            if (/merci|au revoir|c'est tout|c'est bon|plus de questions|rien d'autre/i.test(speechResult)) {
                aiResponse = "Merci pour votre appel et à bientôt ! FIN_APPEL";
            }
            
        } catch (groqError) {
            console.error(`⚠️ Erreur Groq: ${groqError.message}`);
            aiResponse = "Je comprends. Pouvez-vous m'en dire plus ?";
        }
        
        // Sauvegarder la conversation
        conversation.push({ role: 'assistant', content: aiResponse });
        conversations.set(callSid, conversation);
        
        // Extraire infos supplémentaires
        extractUserInfo(callSid, speechResult, aiResponse);
        
        // Détecter fin d'appel
        const shouldEndCall = aiResponse.includes('FIN_APPEL');
        
        if (shouldEndCall) {
            aiResponse = aiResponse.replace('FIN_APPEL', '').trim();
        }
        
        console.log(`⚡ [GROQ] (${Date.now() - startTime}ms): "${aiResponse}"`);
        
        await sendVoiceResponse(res, twiml, aiResponse, callSid, shouldEndCall);
        
    } catch (error) {
        console.error(`❌ Erreur ${callSid}:`, error);
        twiml.say({ voice: 'alice', language: 'fr-FR' }, 
            'Désolé, un problème technique. Un expert vous rappellera.');
        twiml.hangup();
        res.type('text/xml');
        res.send(twiml.toString());
        setTimeout(() => cleanupCall(callSid), 100);
    }
});

// Réponse vocale optimisée
async function sendVoiceResponse(res, twiml, text, callSid, shouldEndCall) {
    const startTime = Date.now();
    
    if (USE_ELEVENLABS && ELEVENLABS_API_KEY) {
        try {
            const audioToken = Buffer.from(`${callSid}:${Date.now()}:${Math.random()}`).toString('base64url');
            global.audioQueue[audioToken] = text;
            
            const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
                ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                : `https://${req.headers.host || 'localhost:3000'}`;
            
            twiml.play(`${baseUrl}/generate-audio/${audioToken}`);
            console.log('🎵 Audio ElevenLabs configuré');
            
        } catch (error) {
            console.error(`❌ Erreur: ${error.message}`);
            twiml.say({ voice: 'alice', language: 'fr-FR' }, text);
        }
    } else {
        twiml.say({ voice: 'alice', language: 'fr-FR' }, text);
        console.log('🔊 Voix Alice (ElevenLabs désactivé)');
    }
    
    if (shouldEndCall) {
        console.log(`🏁 Fin d'appel: ${callSid}`);
        twiml.pause({ length: 1 });
        twiml.hangup();
        setTimeout(() => cleanupCall(callSid), 100);
    } else {
        const profile = userProfiles.get(callSid) || {};
        const timeoutDuration = profile.interactions > 3 ? 2 : 4;
        
        const gather = twiml.gather({
            input: 'speech',
            language: 'fr-FR',
            speechTimeout: 1,
            timeout: timeoutDuration,
            action: '/process-speech',
            method: 'POST',
            speechModel: 'experimental_conversations',
            enhanced: true,
            profanityFilter: false
        });
        
        gather.say({ voice: 'alice', language: 'fr-FR' }, 'Je vous écoute.');
        
        twiml.say({ voice: 'alice', language: 'fr-FR' }, 
            'Merci pour votre appel. Un expert vous recontactera!');
        
        twiml.hangup();
    }
    
    console.log(`⏱️ Réponse en ${Date.now() - startTime}ms`);
    res.type('text/xml');
    res.send(twiml.toString());
}

// Compte rendu d'appel SIMPLE et accessible
async function sendCallSummary(profile, conversation) {
    console.log('📝 Génération compte rendu...');
    
    const fs = require('fs');
    const path = require('path');
    
    // Créer dossier reports
    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    
    const duration = Math.round((Date.now() - profile.startTime) / 1000);
    const timestamp = new Date().toLocaleString('fr-FR');
    
    // Créer contenu du rapport
    const reportContent = `
COMPTE RENDU DYNOVATE - ${timestamp}
═══════════════════════════════════════════

📞 INFORMATIONS APPEL
─────────────────────
Téléphone: ${profile.phone}
Email: ${profile.email || 'Non collecté'}
Secteur: ${profile.sector || 'Non identifié'}
Durée: ${duration}s (${Math.round(duration/60)}min)
Échanges: ${profile.interactions}

📅 RENDEZ-VOUS
─────────────
Demandé: ${profile.rdvRequested ? 'OUI' : 'NON'}
Date: ${profile.rdvDate || 'Non spécifiée'}
Confirmé: ${profile.rdvConfirmed ? 'OUI' : 'NON'}

🎯 ACTIONS À FAIRE
─────────────────
${profile.rdvConfirmed && profile.rdvDate ? '📅 ENVOYER LIEN CALENDLY à ' + profile.phone : ''}
${!profile.email && profile.rdvRequested ? '📧 RAPPELER pour obtenir email' : ''}
${!profile.rdvRequested ? '📞 PROPOSER une démonstration' : ''}

💬 CONVERSATION
──────────────
${conversation.map((msg, index) => 
    `${index + 1}. ${msg.role === 'user' ? 'CLIENT' : 'ASSISTANT'}: ${msg.content}`
).join('\n')}

═══════════════════════════════════════════
Lien Calendly: ${process.env.CALENDLY_LINK || 'https://calendly.com/martin-bouvet-dynovate/reunion-dynovate'}
    `;
    
    // Sauvegarder fichier TXT
    const fileName = `appel_${profile.phone.replace('+', '')}_${Date.now()}.txt`;
    const filePath = path.join(reportsDir, fileName);
    
    try {
        fs.writeFileSync(filePath, reportContent);
        console.log(`✅ Rapport sauvegardé: ${fileName}`);
        
        // Essayer d'envoyer par email
        if (emailTransporter && process.env.REPORT_EMAIL) {
            try {
                await emailTransporter.sendMail({
                    from: `"Dynophone" <${process.env.EMAIL_USER}>`,
                    to: process.env.REPORT_EMAIL,
                    subject: `[APPEL] ${profile.phone} ${profile.rdvRequested ? '- RDV DEMANDÉ' : ''}`,
                    text: reportContent
                });
                console.log('✅ Rapport envoyé par email');
            } catch (emailError) {
                console.error('❌ Erreur envoi email:', emailError.message);
            }
        }
        
    } catch (error) {
        console.error('❌ Erreur sauvegarde:', error.message);
    }
}

function extractUserInfo(callSid, speech, response) {
    const profile = userProfiles.get(callSid) || {};
    const lowerSpeech = speech.toLowerCase();
    
    if (!profile.email) {
        const extractedEmail = extractEmail(speech);
        if (extractedEmail) {
            profile.email = extractedEmail;
        }
    }
    
    const sectors = [
        { keywords: ['restaurant', 'café', 'bar', 'hôtel'], name: 'Restauration' },
        { keywords: ['immobilier', 'agence', 'location'], name: 'Immobilier' },
        { keywords: ['commerce', 'boutique', 'magasin'], name: 'Commerce' },
        { keywords: ['médical', 'médecin', 'cabinet', 'médecine', 'santé', 'docteur'], name: 'Santé' },
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
    const profile = userProfiles.get(callSid);
    const conversation = conversations.get(callSid) || [];
    
    if (profile && profile.interactions > 0) {
        const duration = Math.round((Date.now() - profile.startTime) / 1000);
        console.log(`📊 Fin appel - ${duration}s, ${profile.interactions} échanges`);
        
        await sendCallSummary(profile, conversation);
        
        if (profile.rdvRequested) {
            console.log(`💰 LEAD: RDV ${profile.rdvConfirmed ? 'CONFIRMÉ' : 'DEMANDÉ'} - ${profile.phone}`);
        }
    }
    
    conversations.delete(callSid);
    userProfiles.delete(callSid);
}

function sendFallbackResponse(res, twiml, callSid) {
    console.log(`🚨 Fallback: ${callSid}`);
    
    twiml.say({ voice: 'alice', language: 'fr-FR' }, 'Un instant.');
    
    const gather = twiml.gather({
        input: 'speech',
        language: 'fr-FR',
        speechTimeout: 1,
        timeout: 3,
        action: '/process-speech',
        method: 'POST'
    });
    
    res.type('text/xml');
    res.send(twiml.toString());
}

// Endpoint simple pour voir les rapports
app.get('/rapports', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    
    const reportsDir = path.join(process.cwd(), 'reports');
    
    if (!fs.existsSync(reportsDir)) {
        return res.send('<h1>Aucun rapport trouvé</h1><p>Les rapports apparaîtront ici après les appels.</p>');
    }
    
    try {
        const files = fs.readdirSync(reportsDir)
            .filter(file => file.endsWith('.txt'))
            .sort((a, b) => {
                const statA = fs.statSync(path.join(reportsDir, a));
                const statB = fs.statSync(path.join(reportsDir, b));
                return statB.mtime - statA.mtime;
            });
        
        let html = '<h1>Rapports d\'appels Dynovate</h1>';
        html += `<p>${files.length} rapport(s) trouvé(s)</p>`;
        
        files.forEach(file => {
            const filePath = path.join(reportsDir, file);
            const stats = fs.statSync(filePath);
            const content = fs.readFileSync(filePath, 'utf8');
            
            html += `<div style="border:1px solid #ccc; margin:10px; padding:10px;">`;
            html += `<h3>${file}</h3>`;
            html += `<p><small>Créé le: ${stats.mtime.toLocaleString('fr-FR')}</small></p>`;
            html += `<pre style="white-space: pre-wrap; background:#f5f5f5; padding:10px;">${content}</pre>`;
            html += `</div>`;
        });
        
        res.send(html);
        
    } catch (error) {
        res.send(`<h1>Erreur</h1><p>${error.message}</p>`);
    }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK',
        features: {
            elevenlabs: !!ELEVENLABS_API_KEY,
            email: !!emailTransporter
        }
    });
});

setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000;
    
    for (const [callSid, profile] of userProfiles.entries()) {
        if (now - profile.startTime > maxAge) {
            cleanupCall(callSid);
        }
    }
    
    if (Object.keys(global.audioQueue).length > 100) {
        global.audioQueue = {};
    }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    🚀 Dynovate Assistant IA - VERSION SIMPLE ✅
    ⚡ Port: ${PORT}
    
    ✅ CORRIGÉ:
    💬 Fin d'appel propre (plus de questions en double)
    📊 Rapports accessibles sur /rapports
    📧 Email simple si configuré
    
    📊 RAPPORTS:
    Consultez: https://votre-app.railway.app/rapports
    
    ${emailTransporter ? '✅ Email configuré' : '⚠️ Email non configuré'}
    ${USE_ELEVENLABS ? '🎵 ElevenLabs activé' : '🔇 ElevenLabs désactivé'}
    `);
});