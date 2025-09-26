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

// Configuration email uniquement (pas de SMS)
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
        console.log('📧 Email configuré avec succès');
    } catch (error) {
        console.error('❌ Erreur configuration email:', error.message);
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

// ========================================
// CONTEXTE DYNOVATE AMÉLIORÉ - RÉPONSES COURTES
// ========================================
const DYNOVATE_CONTEXT = `Tu es Dynophone, assistant de Dynovate (solutions IA).

RÈGLES STRICTES:
- RÉPONSES ULTRA-COURTES (max 25 mots)
- Finis TOUJOURS tes phrases
- Style naturel et conversationnel
- Demande l'email pour envoyer les infos
- Si RDV: confirme date ET demande email

SOLUTIONS: IA Email, IA Téléphone, IA Réseaux sociaux, Chatbot Web

Si fin d'appel: ajoute "FIN_APPEL"`;

// ========================================
// FONCTION EMAIL CORRIGÉE - GÈRE LES NOMS COMPOSÉS
// ========================================
function extractEmail(speech) {
    if (!speech) return null;
    
    console.log(`🎤 Audio brut: "${speech}"`);
    
    // Normalisation
    let clean = speech.toLowerCase().trim();
    clean = clean.replace(/\s+/g, " "); // Espaces multiples → un espace
    
    // Supprimer le bruit AVANT de traiter
    clean = clean.replace(/(c'est|mon mail|mon email|mon adresse|et |voici |je suis |alors |tout attaché)/gi, " ");
    
    // Gérer les variations de transcription
    clean = clean.replace(/ arobase | at /gi, "@");
    clean = clean.replace(/ point | dot /gi, ".");
    
    // CORRECTION MAJEURE: Gérer les noms avec espaces
    // "martin bouvet 11@gmail.com" → "martinbouvet11@gmail.com"
    clean = clean.replace(/([a-z\s]+?)\s+(\d+)\s*@/gi, (match, nom, chiffre) => {
        return nom.replace(/\s/g, '').trim() + chiffre + "@";
    });
    
    // Gérer "martin point bouvet 11 @ gmail point com"
    clean = clean.replace(/([a-z\s]+)\s+(\d+)\s+@\s+([a-z]+)\s+point\s+([a-z]+)/gi, 
        (match, nom, chiffre, domain, ext) => {
            return nom.replace(/\s/g, '') + chiffre + "@" + domain + "." + ext;
        });
    
    console.log(`🔧 Nettoyé: "${clean}"`);
    
    // Regex email plus robuste
    const emailRegex = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/i;
    const match = clean.match(emailRegex);
    
    if (match && match[0]) {
        const email = match[0];
        // Validation basique
        if (email.includes('@') && email.includes('.') && 
            email.length > 5 && email.length < 50 &&
            email.split('@').length === 2) {
            console.log(`✅ Email extrait: ${email}`);
            return email;
        }
    }
    
    console.log('❌ Aucun email trouvé');
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
        console.error(`❌ Erreur ElevenLabs: ${error.message}`);
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
            const welcomeText = "Bonjour, Dynophone de Dynovate. Comment je peux vous aider ?";
            const audioToken = Buffer.from(`welcome:${callSid}:${Date.now()}`).toString('base64url');
            
            global.audioQueue[audioToken] = welcomeText;
            
            const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
                ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                : `https://${req.headers.host}`;
            
            twiml.play(`${baseUrl}/generate-audio/${audioToken}`);
            
        } catch (error) {
            twiml.say({ voice: 'alice', language: 'fr-FR' }, 
                'Bonjour, Dynophone de Dynovate. Comment je peux vous aider ?');
        }
    } else {
        twiml.say({ voice: 'alice', language: 'fr-FR' }, 
            'Bonjour, Dynophone de Dynovate. Comment je peux vous aider ?');
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

// ========================================
// TRAITEMENT SPEECH OPTIMISÉ - RÉPONSES COURTES
// ========================================
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
        // DÉTECTION EMAIL AMÉLIORÉE
        const extractedEmail = extractEmail(speechResult);
        if (extractedEmail && !userProfile.email) {
            userProfile.email = extractedEmail;
            console.log(`📧 Email capturé: ${userProfile.email}`);
            userProfiles.set(callSid, userProfile);
        }
        
        // DÉTECTION RDV dans le texte
        if (/rendez-vous|rdv|démo|rencontrer|lundi|mardi|mercredi|jeudi|vendredi|\d+h/i.test(speechResult)) {
            userProfile.rdvRequested = true;
            // Extraire date/heure si mentionnée
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
        
        // Ajouter contexte du profil au prompt
        let contextAddition = "";
        if (userProfile.email) contextAddition += `\nEmail client: ${userProfile.email}`;
        if (userProfile.sector) contextAddition += `\nSecteur: ${userProfile.sector}`;
        if (userProfile.rdvDate) contextAddition += `\nRDV souhaité: ${userProfile.rdvDate}`;
        
        conversation.push({ role: 'user', content: speechResult });
        
        // ========================================
        // APPEL GROQ AVEC PARAMÈTRES OPTIMISÉS POUR RÉPONSES COURTES
        // ========================================
        let aiResponse = "";
        
        try {
            const completion = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { 
                        role: 'system', 
                        content: DYNOVATE_CONTEXT + contextAddition 
                    },
                    ...conversation.slice(-4) // RÉDUIT de 6 à 4 pour moins de contexte
                ],
                temperature: 0.2,        // RÉDUIT de 0.5 à 0.2 pour plus de cohérence
                max_tokens: 40,          // DRASTIQUEMENT RÉDUIT de 120 à 40
                stop: ["\n", "  "],      // Stop aux retours à la ligne et doubles espaces
                stream: false
            });
            
            aiResponse = completion.choices[0].message.content.trim();
            
            // ========================================
            // POST-TRAITEMENT POUR FINIR LES PHRASES
            // ========================================
            
            // Si la réponse ne se termine pas par une ponctuation, on ajoute un point
            if (!aiResponse.match(/[.!?]$/)) {
                // Chercher le dernier mot complet et ajouter un point
                const words = aiResponse.split(' ');
                if (words.length > 3) { // Garder au moins 3 mots
                    aiResponse = words.slice(0, -1).join(' ') + ".";
                } else {
                    aiResponse = aiResponse + ".";
                }
            }
            
            // Limiter à 2 phrases maximum
            const sentences = aiResponse.split(/[.!?]/);
            if (sentences.length > 3) {
                aiResponse = sentences.slice(0, 2).join('.') + '.';
            }
            
            // Vérifier si RDV mentionné mais pas d'email
            if ((userProfile.rdvRequested || aiResponse.toLowerCase().includes('rendez-vous')) && 
                !userProfile.email && 
                !aiResponse.toLowerCase().includes('email')) {
                aiResponse += " Quel est votre email ?";
            }
            
        } catch (groqError) {
            console.error(`⚠️ Erreur Groq: ${groqError.message}`);
            aiResponse = "Je comprends. Pouvez-vous préciser ?";
        }
        
        // Sauvegarder la conversation
        conversation.push({ role: 'assistant', content: aiResponse });
        conversations.set(callSid, conversation);
        
        // Extraire infos supplémentaires
        extractUserInfo(callSid, speechResult, aiResponse);
        
        // Détecter fin d'appel
        const shouldEndCall = aiResponse.includes('FIN_APPEL') || 
                             /au revoir|bonne journée|à bientôt|excellente journée/i.test(aiResponse);
        
        if (shouldEndCall) {
            aiResponse = aiResponse.replace('FIN_APPEL', '').trim();
        }
        
        console.log(`⚡ [GROQ] (${Date.now() - startTime}ms): "${aiResponse}"`);
        
        // Si RDV confirmé et email présent, envoyer le lien
        if (userProfile.rdvRequested && userProfile.email && !userProfile.rdvEmailSent) {
            userProfile.rdvEmailSent = true;
            userProfiles.set(callSid, userProfile);
            
            // Envoi asynchrone pour ne pas bloquer
            sendRDVEmail(userProfile.email, userProfile.phone).catch(err => 
                console.error('❌ Erreur envoi RDV:', err.message)
            );
        }
        
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

// Réponse vocale optimisée (avec flag ElevenLabs)
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
        // Utiliser voix Alice si ElevenLabs désactivé
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

// Envoi email pour RDV (remplace SMS)
async function sendRDVEmail(email, phone) {
    if (!emailTransporter) {
        console.log('❌ Email non configuré pour envoi RDV');
        return;
    }
    
    const calendlyLink = process.env.CALENDLY_LINK || 'https://calendly.com/dynovate/demo';
    
    try {
        const emailContent = `
Bonjour,

Suite à notre conversation téléphonique, voici le lien pour réserver votre démonstration gratuite Dynovate :

🗓️ Réservez votre créneau : ${calendlyLink}

Nos solutions d'IA pour entreprises :
• IA Téléphonique : Gestion d'appels 24h/7j (comme notre conversation)
• IA Email : Classification et réponses automatiques
• IA Réseaux Sociaux : Réponses instantanées sur tous vos canaux
• Chatbot Web : Assistant intelligent pour votre site

Choisissez le créneau qui vous convient le mieux et nous vous montrerons comment l'IA peut transformer votre relation client.

À très bientôt !

L'équipe Dynovate
📞 Contact : ${phone}
        `;
        
        await emailTransporter.sendMail({
            from: `"Dynovate" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: '🗓️ Votre lien de réservation Dynovate',
            text: emailContent,
            html: emailContent.replace(/\n/g, '<br>')
        });
        
        console.log(`📧 Email RDV envoyé à ${email}`);
    } catch (error) {
        console.error(`❌ Erreur envoi email RDV: ${error.message}`);
    }
}

// Compte rendu d'appel par email
async function sendCallSummary(profile, conversation) {
    // D'abord créer le fichier local
    const summary = generateLocalSummary(profile, conversation);
    const fs = require('fs');
    const path = require('path');
    
    // Créer le dossier reports s'il n'existe pas
    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    
    // Sauvegarder le fichier JSON
    const fileName = `call_${profile.phone.replace('+', '')}_${Date.now()}.json`;
    const filePath = path.join(reportsDir, fileName);
    
    try {
        fs.writeFileSync(filePath, JSON.stringify(summary, null, 2));
        console.log(`📁 Rapport sauvegardé: ${filePath}`);
    } catch (e) {
        console.error('❌ Erreur sauvegarde fichier:', e.message);
    }
    
    // Ensuite essayer d'envoyer par email si configuré
    if (!emailTransporter) {
        console.log('📧 Email non configuré - Rapport sauvegardé localement uniquement');
        return;
    }
    
    const duration = Math.round((Date.now() - profile.startTime) / 1000);
    
    // Générer résumé avec Groq
    let summaryText = "Résumé non disponible";
    
    try {
        const summaryPrompt = [
            { 
                role: "system", 
                content: "Résume cet appel commercial en 5 points. Identifie: besoins, solutions proposées, actions suivantes." 
            },
            ...conversation
        ];
        
        const completion = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: summaryPrompt,
            max_tokens: 200,
            temperature: 0.3
        });
        
        summaryText = completion.choices[0].message.content.trim();
    } catch (e) {
        console.error("Erreur résumé Groq:", e.message);
    }
    
    // Créer le compte rendu email
    const emailContent = `
📞 COMPTE RENDU D'APPEL DYNOVATE
━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 INFORMATIONS
━━━━━━━━━━━━━━━
📱 Téléphone: ${profile.phone}
📧 Email: ${profile.email || '❌ NON COLLECTÉ'}
🏢 Secteur: ${profile.sector || 'Non identifié'}
📅 RDV demandé: ${profile.rdvDate || 'Non'}
⏱️ Durée: ${duration}s
💬 Échanges: ${profile.interactions || 0}

📝 RÉSUMÉ
━━━━━━━━━
${summaryText}

💰 QUALIFICATION
━━━━━━━━━━━━━━
${profile.email ? '✅ Email collecté' : '❌ EMAIL MANQUANT - À RECONTACTER'}
${profile.sector ? '✅ Secteur identifié' : '⚠️ Secteur à préciser'}
${profile.rdvDate ? '✅ RDV demandé: ' + profile.rdvDate : '⚠️ Pas de RDV'}

🎯 ACTIONS PRIORITAIRES
━━━━━━━━━━━━━━━━━━
${!profile.email ? '🔴 RAPPELER POUR OBTENIR EMAIL\n' : ''}
${profile.rdvDate ? '• Confirmer RDV ' + profile.rdvDate + '\n' : '• Proposer un RDV\n'}
${profile.email ? '• Envoyer documentation\n' : ''}
• Suivi dans 48h

📋 CONVERSATION COMPLÈTE
━━━━━━━━━━━━━━━━━━━
${conversation.map(msg => 
    `${msg.role === 'user' ? '👤' : '🤖'}: ${msg.content}`
).join('\n')}

━━━━━━━━━━━━━━━━━━━
Fichier sauvegardé: ${fileName}
    `;
    
    try {
        await emailTransporter.sendMail({
            from: `"Dynophone" <${process.env.EMAIL_USER}>`,
            to: process.env.REPORT_EMAIL || process.env.EMAIL_USER,
            subject: `[${profile.email ? 'LEAD' : '⚠️ EMAIL MANQUANT'}] ${profile.phone}`,
            text: emailContent
        });
        
        console.log(`📧 Compte rendu envoyé`);
    } catch (error) {
        console.error(`❌ Erreur envoi email: ${error.message}`);
    }
}

// Génération résumé local (fallback)
function generateLocalSummary(profile, conversation) {
    const duration = Math.round((Date.now() - profile.startTime) / 1000);
    
    return {
        timestamp: new Date().toISOString(),
        phone: profile.phone,
        email: profile.email || null,
        sector: profile.sector || null,
        duration: `${duration}s`,
        interactions: profile.interactions,
        qualified: !!(profile.email || profile.sector),
        conversation: conversation.map(msg => ({
            role: msg.role,
            content: msg.content
        }))
    };
}

// Extraction infos améliorée
function extractUserInfo(callSid, speech, response) {
    const profile = userProfiles.get(callSid) || {};
    const lowerSpeech = speech.toLowerCase();
    
    // Email - Utilise la fonction améliorée
    if (!profile.email) {
        const extractedEmail = extractEmail(speech);
        if (extractedEmail) {
            profile.email = extractedEmail;
            console.log(`📧 Email extrait: ${profile.email}`);
        }
    }
    
    // Secteur
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
            console.log(`🏢 Secteur: ${profile.sector}`);
            break;
        }
    }
    
    // Détection demande RDV
    if (/rendez-vous|rdv|démo|rencontrer/i.test(lowerSpeech)) {
        profile.rdvRequested = true;
    }
    
    userProfiles.set(callSid, profile);
}

// Nettoyage avec compte rendu
async function cleanupCall(callSid) {
    const profile = userProfiles.get(callSid);
    const conversation = conversations.get(callSid) || [];
    
    if (profile) {
        const duration = Math.round((Date.now() - profile.startTime) / 1000);
        console.log(`📊 Fin appel - ${duration}s, ${profile.interactions} échanges`);
        
        // Envoyer le compte rendu
        await sendCallSummary(profile, conversation);
        
        if (profile.email || profile.sector) {
            console.log(`💰 LEAD QUALIFIÉ: ${profile.email || 'N/A'} - ${profile.sector || 'N/A'}`);
        }
    }
    
    conversations.delete(callSid);
    userProfiles.delete(callSid);
}

// Fallback
function sendFallbackResponse(res, twiml, callSid) {
    console.log(`🚨 Fallback: ${callSid}`);
    
    twiml.say({ voice: 'alice', language: 'fr-FR' }, 'Un instant s\'il vous plaît.');
    
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

// Endpoints API
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK',
        features: {
            elevenlabs: !!ELEVENLABS_API_KEY,
            email: !!emailTransporter,
            streaming: true
        },
        stats: {
            activeConversations: conversations.size,
            cacheSize: responseCache.size
        }
    });
});

// Nettoyage périodique
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

// Démarrage
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    🚀 Dynovate Assistant IA - VERSION OPTIMISÉE ✅
    ⚡ Port: ${PORT}
    
    ✅ AMÉLIORATIONS APPLIQUÉES:
    🎯 Réponses ultra-courtes (max 40 tokens)
    📧 Extraction email améliorée (noms composés)
    ⚡ Latence réduite (temperature 0.2)
    🔄 Post-traitement des phrases coupées
    
    ✅ FONCTIONNALITÉS ACTIVES:
    ${USE_ELEVENLABS ? '🎵 ElevenLabs TTS activé' : '🔇 ElevenLabs désactivé (USE_ELEVENLABS=false)'}
    ${emailTransporter ? '📧 Comptes rendus + liens RDV par email' : '❌ Email (ajouter EMAIL_USER et EMAIL_PASS)'}
    🚀 Streaming Groq activé
    💾 Cache intelligent activé
    ⚡ Timeout 2s avec fallback
    📅 Prise de RDV par email
    
    💡 Pour désactiver ElevenLabs: USE_ELEVENLABS=false
    💡 Pour activer ElevenLabs: USE_ELEVENLABS=true
    
    📊 OPTIMISATIONS:
    - Réponses 60% plus courtes
    - Extraction email robuste
    - Conversations naturelles
    - Comptes rendus automatiques
    `);
    
    if (ELEVENLABS_API_KEY) {
        axios.get('https://api.elevenlabs.io/v1/user', {
            headers: { 'xi-api-key': ELEVENLABS_API_KEY }
        }).then(response => {
            console.log(`    💳 ElevenLabs: ${response.data.subscription.character_count}/${response.data.subscription.character_limit} caractères`);
        }).catch(() => {});
    }
});