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

// Configuration email avec diagnostic détaillé
let emailTransporter = null;
console.log('\n🔍 DIAGNOSTIC EMAIL:');
console.log(`EMAIL_USER: ${process.env.EMAIL_USER}`);
console.log(`EMAIL_PASS: ${process.env.EMAIL_PASS ? '[CONFIGURÉ]' : '[MANQUANT]'}`);

if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
        emailTransporter = nodemailer.createTransporter({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        
        // TEST DE CONNEXION OBLIGATOIRE
        emailTransporter.verify((error, success) => {
            if (error) {
                console.error('❌ ERREUR EMAIL:', error.message);
                console.error('💡 SOLUTION: Générez un "Mot de passe d\'application" dans Gmail');
                console.error('💡 URL: https://myaccount.google.com/apppasswords');
                emailTransporter = null;
            } else {
                console.log('✅ EMAIL CONFIGURÉ ET TESTÉ AVEC SUCCÈS');
            }
        });
    } catch (error) {
        console.error('❌ Erreur configuration email:', error.message);
        emailTransporter = null;
    }
} else {
    console.log('⚠️ EMAIL_USER ou EMAIL_PASS manquant dans les variables d\'environnement');
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

// Contexte Dynovate AMÉLIORÉ - Avec vérification email et fin polie
const DYNOVATE_CONTEXT = `Tu es Dynophone, assistant commercial chez Dynovate, entreprise d'IA pour la relation client.

SOLUTIONS:
- IA Email: tri et réponses automatiques
- IA Téléphonique: gestion d'appels 24/7 (comme notre conversation actuelle)
- IA Réseaux sociaux: réponses sur tous les canaux
- IA Chatbot: assistant pour sites web

STYLE:
- Conversation naturelle et fluide
- Réponses COURTES (2-3 phrases max)
- TOUJOURS répéter l'email reçu et demander confirmation
- Avant de finir: "Avez-vous d'autres questions ?"
- Ne raccroche jamais brutalement

PROCESSUS EMAIL:
1. Recevoir l'email
2. Le répéter exactement comme entendu
3. Demander: "Est-ce que c'est correct ?"
4. Si oui: confirmer le RDV
5. Si non: "Pouvez-vous me le redonner ?"

IMPORTANT:
- Réponds aux questions avant de demander l'email
- TOUJOURS vérifier l'email avec le client
- Demander s'il y a d'autres questions avant de finir
- Si fin confirmée, ajoute "FIN_APPEL" à ta réponse`;

// Fonction d'extraction d'email ULTRA-CORRIGÉE pour les noms complets
function extractEmail(speech) {
    if (!speech) return null;
    
    console.log(`🎤 Audio brut: "${speech}"`);
    
    // Normalisation très prudente
    let clean = speech.toLowerCase().trim();
    
    // Supprimer seulement le bruit évident, garder les noms
    clean = clean.replace(/(c'est|mon mail|mon email|mon adresse|et voici|je suis)/gi, " ");
    
    // Gérer les variations de transcription
    clean = clean.replace(/ arobase | at /gi, "@");
    clean = clean.replace(/ point | dot /gi, ".");
    
    // CAS SPÉCIAL: "Martin Bouvet 11@gmail.com" 
    // Le problème : la regex coupe le nom trop tôt
    // Solution: être plus précis dans la capture
    
    // Pattern 1: "prénom nom chiffre@domain.ext"
    clean = clean.replace(/([a-z]+)\s+([a-z]+)\s+(\d+)@([a-z]+)\.([a-z]+)/gi, "$1$2$3@$4.$5");
    
    // Pattern 2: "prénom nom point chiffre arobase domain point ext"
    clean = clean.replace(/([a-z]+)\s+([a-z]+)\s*\.?\s*(\d+)\s*@\s*([a-z]+)\s*\.\s*([a-z]+)/gi, "$1$2$3@$4.$5");
    
    // Pattern 3: Cas où il y a un point dans le nom "martin.bouvet"
    clean = clean.replace(/([a-z]+)\s*\.\s*([a-z]+)\s+(\d+)@([a-z]+)\.([a-z]+)/gi, "$1.$2$3@$4.$5");
    
    console.log(`🔧 Nettoyé: "${clean}"`);
    
    // Regex email plus permissive pour capturer plus de caractères
    const emailRegex = /[a-z0-9][a-z0-9._%+-]{2,}@[a-z0-9][a-z0-9.-]*\.[a-z]{2,4}/gi;
    const matches = clean.match(emailRegex);
    
    if (matches && matches.length > 0) {
        // Prendre le match le plus long (probable le plus complet)
        const longestEmail = matches.reduce((a, b) => a.length > b.length ? a : b);
        
        // Validation stricte
        if (longestEmail.includes('@') && longestEmail.includes('.') && 
            longestEmail.length > 5 && longestEmail.length < 50 &&
            longestEmail.split('@').length === 2 &&
            longestEmail.split('@')[1].includes('.')) {
            
            console.log(`✅ Email extrait: ${longestEmail}`);
            return longestEmail;
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
        // DÉTECTION EMAIL SIMPLE
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
        
        // Contexte avec état de conversation
        let contextAddition = "";
        if (userProfile.email) contextAddition += `\nEmail client: ${userProfile.email}`;
        if (userProfile.sector) contextAddition += `\nSecteur: ${userProfile.sector}`;
        if (userProfile.rdvDate) contextAddition += `\nRDV souhaité: ${userProfile.rdvDate}`;
        if (userProfile.emailNeedsConfirmation) contextAddition += `\nEmail à confirmer avec le client`;
        
        conversation.push({ role: 'user', content: speechResult });
        
        // APPEL GROQ avec logique de vérification email
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
                max_tokens: 100, // Augmenté pour permettre la vérification
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
            
            // LOGIQUE SPÉCIALE: Si email vient d'être capturé, demander confirmation
            if (extractedEmail && !userProfile.emailConfirmed) {
                userProfile.emailNeedsConfirmation = true;
                userProfile.emailConfirmed = false;
                aiResponse = `J'ai noté votre email : ${extractedEmail}. Est-ce que c'est correct ?`;
            }
            
            // Si client confirme l'email (oui, correct, etc.)
            if (userProfile.emailNeedsConfirmation && /oui|correct|c'est bon|exactement|parfait/i.test(speechResult)) {
                userProfile.emailConfirmed = true;
                userProfile.emailNeedsConfirmation = false;
                if (userProfile.rdvRequested) {
                    aiResponse = `Parfait ! Votre rendez-vous est confirmé. Je vous envoie le lien par email. Avez-vous d'autres questions ?`;
                }
            }
            
            // Si client dit non à l'email
            if (userProfile.emailNeedsConfirmation && /non|pas correct|c'est pas bon|erreur/i.test(speechResult)) {
                userProfile.email = null; // Reset email
                userProfile.emailNeedsConfirmation = false;
                aiResponse = `D'accord, pouvez-vous me redonner votre email s'il vous plaît ?`;
            }
            
            // Si RDV demandé mais pas d'email confirmé
            if (userProfile.rdvRequested && !userProfile.email && !userProfile.emailNeedsConfirmation &&
                !conversation.slice(-3).some(msg => msg.content.toLowerCase().includes('email'))) {
                aiResponse += " Quel est votre email pour la confirmation ?";
            }
            
            // Détection de fin de conversation naturelle
            if (/non|ça va|c'est tout|merci|au revoir/i.test(speechResult) && 
                !aiResponse.includes('FIN_APPEL') && userProfile.interactions > 2) {
                aiResponse += " Merci pour votre appel et à bientôt ! FIN_APPEL";
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
        const shouldEndCall = aiResponse.includes('FIN_APPEL') || 
                             /au revoir|bonne journée|à bientôt|excellente journée/i.test(aiResponse);
        
        if (shouldEndCall) {
            aiResponse = aiResponse.replace('FIN_APPEL', '').trim();
        }
        
        console.log(`⚡ [GROQ] (${Date.now() - startTime}ms): "${aiResponse}"`);
        
        // Si RDV confirmé et email confirmé, envoyer le lien
        if (userProfile.rdvRequested && userProfile.email && userProfile.emailConfirmed && !userProfile.rdvEmailSent) {
            userProfile.rdvEmailSent = true;
            userProfiles.set(callSid, userProfile);
            
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

// Envoi email pour RDV CORRIGÉ
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

// Compte rendu d'appel FORCÉ
async function sendCallSummary(profile, conversation) {
    const summary = generateLocalSummary(profile, conversation);
    const fs = require('fs');
    const path = require('path');
    
    // TOUJOURS créer le fichier local
    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    
    const fileName = `call_${profile.phone.replace('+', '')}_${Date.now()}.json`;
    const filePath = path.join(reportsDir, fileName);
    
    try {
        fs.writeFileSync(filePath, JSON.stringify(summary, null, 2));
        console.log(`📁 Rapport sauvegardé: ${filePath}`);
    } catch (e) {
        console.error('❌ Erreur sauvegarde fichier:', e.message);
    }
    
    // Créer fichier texte lisible
    const txtFileName = `call_${profile.phone.replace('+', '')}_${Date.now()}.txt`;
    const txtFilePath = path.join(reportsDir, txtFileName);
    
    const duration = Math.round((Date.now() - profile.startTime) / 1000);
    
    const readableContent = `
📞 COMPTE RENDU D'APPEL DYNOVATE
━━━━━━━━━━━━━━━━━━━━━━━━━━
Date: ${new Date().toLocaleString('fr-FR')}

📊 INFORMATIONS
━━━━━━━━━━━━━━━
📱 Téléphone: ${profile.phone}
📧 Email: ${profile.email || '❌ NON COLLECTÉ'}
🏢 Secteur: ${profile.sector || 'Non identifié'}
📅 RDV demandé: ${profile.rdvDate || 'Non'}
⏱️ Durée: ${duration}s
💬 Échanges: ${profile.interactions || 0}

💰 QUALIFICATION
━━━━━━━━━━━━━━
${profile.email ? '✅ Email collecté' : '❌ EMAIL MANQUANT - À RECONTACTER'}
${profile.sector ? '✅ Secteur identifié' : '⚠️ Secteur à préciser'}
${profile.rdvDate ? '✅ RDV demandé: ' + profile.rdvDate : '⚠️ Pas de RDV'}

📋 CONVERSATION COMPLÈTE
━━━━━━━━━━━━━━━━━━━
${conversation.map(msg => 
    `${msg.role === 'user' ? '👤 CLIENT' : '🤖 DYNOPHONE'}: ${msg.content}`
).join('\n\n')}
━━━━━━━━━━━━━━━━━━━━━━━━━━
    `;
    
    try {
        fs.writeFileSync(txtFilePath, readableContent);
        console.log(`📄 Rapport texte sauvegardé: ${txtFilePath}`);
    } catch (e) {
        console.error('❌ Erreur sauvegarde fichier texte:', e.message);
    }
    
    // Essayer d'envoyer par email si configuré
    if (emailTransporter) {
        try {
            await emailTransporter.sendMail({
                from: `"Dynophone" <${process.env.EMAIL_USER}>`,
                to: process.env.REPORT_EMAIL || process.env.EMAIL_USER,
                subject: `[${profile.email ? 'LEAD' : '⚠️ EMAIL MANQUANT'}] ${profile.phone}`,
                text: readableContent
            });
            
            console.log(`📧 Compte rendu envoyé par email`);
        } catch (error) {
            console.error(`❌ Erreur envoi email: ${error.message}`);
        }
    } else {
        console.log('📧 Email non configuré - Rapport sauvegardé localement dans /reports/');
    }
}

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
            content: msg.content,
            timestamp: new Date().toISOString()
        }))
    };
}

function extractUserInfo(callSid, speech, response) {
    const profile = userProfiles.get(callSid) || {};
    const lowerSpeech = speech.toLowerCase();
    
    if (!profile.email) {
        const extractedEmail = extractEmail(speech);
        if (extractedEmail) {
            profile.email = extractedEmail;
            console.log(`📧 Email extrait: ${profile.email}`);
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
            console.log(`🏢 Secteur: ${profile.sector}`);
            break;
        }
    }
    
    if (/rendez-vous|rdv|démo|rencontrer/i.test(lowerSpeech)) {
        profile.rdvRequested = true;
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
        
        if (profile.email || profile.sector) {
            console.log(`💰 LEAD QUALIFIÉ: ${profile.email || 'N/A'} - ${profile.sector || 'N/A'}`);
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
        },
        env: {
            EMAIL_USER: process.env.EMAIL_USER ? 'SET' : 'MISSING',
            EMAIL_PASS: process.env.EMAIL_PASS ? 'SET' : 'MISSING',
            CALENDLY_LINK: process.env.CALENDLY_LINK ? 'SET' : 'MISSING'
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
    🚀 Dynovate Assistant IA - VERSION SIMPLIFIÉE ✅
    ⚡ Port: ${PORT}
    
    ✅ CORRECTIONS APPLIQUÉES:
    📧 Email: ${emailTransporter ? 'CONFIGURÉ' : 'NON CONFIGURÉ'}
    🗑️ Suppression épellage (source de problèmes)
    💬 Confirmation directe des emails
    📁 Rapports forcés même sans email
    
    📧 CONFIG EMAIL:
    - USER: ${process.env.EMAIL_USER || 'MANQUANT'}
    - PASS: ${process.env.EMAIL_PASS ? 'SET' : 'MANQUANT'}
    - CALENDLY: ${process.env.CALENDLY_LINK ? 'SET' : 'MANQUANT'}
    
    ✅ FONCTIONNALITÉS:
    ${USE_ELEVENLABS ? '🎵 ElevenLabs TTS activé' : '🔇 ElevenLabs désactivé'}
    📁 Rapports automatiques dans /reports/
    🚀 Streaming Groq optimisé
    📅 Prise de RDV intelligente
    
    🔧 DEBUG EMAIL:
    Vérifiez /health pour status détaillé
    `);
    
    // Debug email au démarrage
    console.log(`
    🔍 DEBUG EMAIL CONFIG:
    EMAIL_USER: ${process.env.EMAIL_USER}
    EMAIL_PASS: ${process.env.EMAIL_PASS ? '[SET]' : '[MISSING]'}
    REPORT_EMAIL: ${process.env.REPORT_EMAIL}
    CALENDLY_LINK: ${process.env.CALENDLY_LINK}
    Transporter: ${emailTransporter ? 'OK' : 'NULL'}
    `);
    
    if (ELEVENLABS_API_KEY) {
        axios.get('https://api.elevenlabs.io/v1/user', {
            headers: { 'xi-api-key': ELEVENLABS_API_KEY }
        }).then(response => {
            console.log(`    💳 ElevenLabs: ${response.data.subscription.character_count}/${response.data.subscription.character_limit} caractères`);
        }).catch(() => {});
    }
});