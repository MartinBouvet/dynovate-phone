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
        emailTransporter = nodemailer.createTransport({
            service: 'gmail',
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            },
            tls: {
                rejectUnauthorized: false
            }
        });
        
        console.log('🔧 Transporter créé, test en cours...');
        
        emailTransporter.verify((error, success) => {
            if (error) {
                console.error('❌ ERREUR EMAIL:', error.message);
                console.error('💡 VÉRIFIEZ:');
                console.error('   1. Authentification 2FA activée sur Gmail');
                console.error('   2. Mot de passe d\'application généré');
                console.error('   3. URL: https://myaccount.google.com/apppasswords');
            } else {
                console.log('✅ EMAIL CONFIGURÉ ET TESTÉ AVEC SUCCÈS');
            }
        });
        
    } catch (error) {
        console.error('❌ Erreur création transporter:', error.message);
        emailTransporter = null;
    }
} else {
    console.log('⚠️ EMAIL_USER ou EMAIL_PASS manquant');
}

// Stockage global
global.audioQueue = {};
global.streamingResponses = {};

// Stockage conversations + PROTECTION ANTI-DOUBLONS
const conversations = new Map();
const userProfiles = new Map();
const responseCache = new Map();
const processedCalls = new Set(); // ✅ NOUVEAU: éviter les doublons de rapports

// Middleware
app.use(express.urlencoded({ extended: false }));

// Contexte Dynovate AMÉLIORE - Solutions complètes obligatoires
const DYNOVATE_CONTEXT = `Tu es Dynophone, assistant commercial chez Dynovate.

SOLUTIONS (TOUJOURS présenter les 4 solutions ensemble quand on demande "vos solutions"):
1. IA Email: Analyse et tri automatique des emails, réponses automatiques aux clients. Fait gagner 70% de temps de traitement.
2. IA Téléphonique: Gestion d'appels 24/7 comme notre conversation actuelle. Prise de RDV automatique.
3. IA Réseaux sociaux: Réponses automatiques sur Facebook, Instagram, Twitter. Disponible 24h/24.
4. IA Chatbot: Assistant intelligent sur votre site web pour répondre aux visiteurs en temps réel.

RÈGLES STRICTES:
1. RÉPONSES COURTES: Maximum 2 phrases par réponse
2. Quand on demande "vos solutions" → présenter les 4 solutions ci-dessus
3. Une seule question de relance par réponse maximum
4. Phrases complètes seulement
5. Si client dit "merci" ou "au revoir" → répondre "Merci pour votre appel, à bientôt !" et STOPPER

GESTION RDV:
- Si demande RDV → "Je note votre demande. Quelle date vous convient ?"
- Si date donnée → "Parfait, c'est noté pour [date]. Nous vous recontacterons."
- Après confirmation RDV → ne plus en reparler

IMPORTANT: Toujours des réponses très courtes et naturelles.`;

// Fonction d'extraction d'email SIMPLIFIÉE
function extractEmail(speech) {
    if (!speech) return null;
    
    console.log(`🎤 Audio brut: "${speech}"`);
    
    let clean = speech.toLowerCase().trim();
    clean = clean.replace(/(c'est|mon mail|mon email|mon adresse)/gi, " ");
    clean = clean.replace(/ arobase | at /gi, "@");
    clean = clean.replace(/ point | dot /gi, ".");
    clean = clean.replace(/([a-z]+)\s+([a-z]+)\s+(\d+)@([a-z]+)\.([a-z]+)/gi, "$1$2$3@$4.$5");
    
    console.log(`🔧 Nettoyé: "${clean}"`);
    
    const emailRegex = /[a-z0-9][a-z0-9._%+-]{2,}@[a-z0-9][a-z0-9.-]*\.[a-z]{2,4}/gi;
    const matches = clean.match(emailRegex);
    
    if (matches && matches.length > 0) {
        const longestEmail = matches.reduce((a, b) => a.length > b.length ? a : b);
        
        if (longestEmail.includes('@') && longestEmail.includes('.') && 
            longestEmail.length > 5 && longestEmail.length < 50) {
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
        const response = await axios({
            method: 'POST',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
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
        
    } catch (error) {
        console.error(`❌ Erreur ElevenLabs: ${error.message}`);
        delete global.audioQueue[token];
        res.status(500).send('Error');
    }
});

// Route principale - WEBHOOK TWILIO STATUS pour détecter vraie fin d'appel
app.post('/call-status', async (req, res) => {
    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;
    
    console.log(`📡 Status ${callSid}: ${callStatus}`);
    
    // ✅ Générer rapport UNIQUEMENT quand l'appel est vraiment terminé
    if (callStatus === 'completed') {
        console.log(`🏁 Appel réellement terminé: ${callSid}`);
        setTimeout(() => cleanupCall(callSid), 500);
    }
    
    res.status(200).send('OK');
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
    
    // ✅ CONFIGURER WEBHOOK STATUS pour détecter fin réelle d'appel
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : `https://${req.headers.host}`;
    
    twiml.on('statusCallback', `${baseUrl}/call-status`);
    
    // Message d'accueil simple et court
    const welcomeText = "Bonjour, Dynophone de Dynovate. Comment puis-je vous aider ?";
    
    if (USE_ELEVENLABS && ELEVENLABS_API_KEY) {
        try {
            const audioToken = Buffer.from(`welcome:${callSid}:${Date.now()}`).toString('base64url');
            global.audioQueue[audioToken] = welcomeText;
            
            twiml.play(`${baseUrl}/generate-audio/${audioToken}`);
            
        } catch (error) {
            twiml.say({ voice: 'alice', language: 'fr-FR' }, welcomeText);
        }
    } else {
        twiml.say({ voice: 'alice', language: 'fr-FR' }, welcomeText);
    }
    
    const gather = twiml.gather({
        input: 'speech',
        language: 'fr-FR',
        speechTimeout: 2,
        timeout: 5,
        action: '/process-speech',
        method: 'POST',
        speechModel: 'experimental_conversations',
        enhanced: true,
        profanityFilter: false
    });
    
    twiml.redirect('/voice');
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// Traitement speech CORRIGÉ - Pas de max_tokens, prompt pour réponses courtes
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
            const dateMatch = speechResult.match(/(lundi|mardi|mercredi|jeudi|vendredi|demain|après-demain|\d+\s*(octobre|novembre|décembre)).*?(\d+h|\d+:\d+)?/i);
            if (dateMatch) {
                userProfile.rdvDate = dateMatch[0];
                console.log(`📅 RDV demandé: ${userProfile.rdvDate}`);
            }
        }
        
        // DÉTECTION FIN D'APPEL AMÉLIORÉE
        const endPhrases = /merci|au revoir|c'est tout|c'est bon|plus de questions|rien d'autre|bonne journée|à bientôt|j'ai fini|c'est parfait/i;
        const shouldEndCall = endPhrases.test(speechResult);
        
        // PRÉPARER CONVERSATION
        const conversation = conversations.get(callSid) || [];
        userProfile.interactions = (userProfile.interactions || 0) + 1;
        userProfiles.set(callSid, userProfile);
        
        // Contexte avec état de conversation
        let contextAddition = "";
        if (userProfile.email) contextAddition += `\nEmail client: ${userProfile.email}`;
        if (userProfile.sector) contextAddition += `\nSecteur: ${userProfile.sector}`;
        if (userProfile.rdvDate) contextAddition += `\nRDV souhaité: ${userProfile.rdvDate}`;
        
        conversation.push({ role: 'user', content: speechResult });
        
        let aiResponse = "";
        
        // LOGIQUE FIN D'APPEL EN PRIORITÉ
        if (shouldEndCall) {
            aiResponse = "Merci pour votre appel et à bientôt !";
            console.log(`🏁 Fin d'appel détectée: ${callSid}`);
        } else {
            try {
                // APPEL GROQ - SANS max_tokens, avec instructions claires
                const completion = await groq.chat.completions.create({
                    model: 'llama-3.3-70b-versatile',
                    messages: [
                        { 
                            role: 'system', 
                            content: DYNOVATE_CONTEXT + contextAddition + "\n\nIMPORTANT: Réponds en maximum 2 phrases courtes et complètes. Sois naturel et commercial."
                        },
                        ...conversation.slice(-6)
                    ],
                    temperature: 0.3,
                    stream: false
                });
                
                aiResponse = completion.choices[0].message.content.trim();
                
                // NETTOYAGE POST-TRAITEMENT MINIMAL
                // Supprimer les listes et formatting indésirable
                aiResponse = aiResponse.replace(/^\d+\.\s*/gm, ''); // Supprimer "1. 2. etc"
                aiResponse = aiResponse.replace(/^[-•*]\s*/gm, ''); // Supprimer tirets/puces
                aiResponse = aiResponse.replace(/\n+/g, ' '); // Une seule ligne
                
                // S'assurer qu'on finit par une ponctuation
                if (!aiResponse.match(/[.!?]$/)) {
                    const lastPunctuation = Math.max(
                        aiResponse.lastIndexOf('.'),
                        aiResponse.lastIndexOf('!'),
                        aiResponse.lastIndexOf('?')
                    );
                    
                    if (lastPunctuation > aiResponse.length - 20) {
                        aiResponse = aiResponse.substring(0, lastPunctuation + 1);
                    } else {
                        aiResponse = aiResponse + '.';
                    }
                }
                
                // LOGIQUE RDV SIMPLIFIÉE
                if (userProfile.rdvRequested && userProfile.rdvDate && !userProfile.rdvConfirmed) {
                    userProfile.rdvConfirmed = true;
                    aiResponse = `Parfait, c'est noté pour ${userProfile.rdvDate}. Nous vous recontacterons.`;
                }
                
            } catch (groqError) {
                console.error(`⚠️ Erreur Groq: ${groqError.message}`);
                aiResponse = "Je comprends. Pouvez-vous m'en dire plus ?";
            }
        }
        
        // Sauvegarder la conversation
        conversation.push({ role: 'assistant', content: aiResponse });
        conversations.set(callSid, conversation);
        
        // Extraire infos supplémentaires
        extractUserInfo(callSid, speechResult, aiResponse);
        
        console.log(`⚡ [GROQ] (${Date.now() - startTime}ms): "${aiResponse}"`);
        
        await sendVoiceResponse(res, twiml, aiResponse, callSid, shouldEndCall);
        
    } catch (error) {
        console.error(`❌ Erreur ${callSid}:`, error);
        twiml.say({ voice: 'alice', language: 'fr-FR' }, 
            'Désolé, un problème technique. Un expert vous rappellera.');
        twiml.hangup();
        res.type('text/xml');
        res.send(twiml.toString());
        // ✅ DÉLAI UNIQUE même pour erreurs
        setTimeout(() => cleanupCall(callSid), 1000);
    }
});

// Réponse vocale optimisée CORRIGÉE
async function sendVoiceResponse(res, twiml, text, callSid, shouldEndCall) {
    const startTime = Date.now();
    
    if (USE_ELEVENLABS && ELEVENLABS_API_KEY) {
        try {
            const audioToken = Buffer.from(`${callSid}:${Date.now()}:${Math.random()}`).toString('base64url');
            global.audioQueue[audioToken] = text;
            
            const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
                ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                : 'https://localhost:3000';
            
            twiml.play(`${baseUrl}/generate-audio/${audioToken}`);
            console.log('🎵 Audio ElevenLabs configuré');
            
        } catch (error) {
            console.error(`❌ Erreur ElevenLabs: ${error.message}`);
            twiml.say({ voice: 'alice', language: 'fr-FR' }, text);
        }
    } else {
        twiml.say({ voice: 'alice', language: 'fr-FR' }, text);
        console.log('🔊 Voix Alice (ElevenLabs désactivé)');
    }
    
    if (shouldEndCall) {
        console.log(`🏁 Fin d'appel programmée: ${callSid}`);
        twiml.pause({ length: 1 });
        twiml.hangup();
        // ✅ DÉLAI UNIQUE pour éviter appels multiples à cleanupCall
        setTimeout(() => cleanupCall(callSid), 1000);
    } else {
        // GATHER AMÉLIORÉ - timeout plus long pour éviter coupures
        const gather = twiml.gather({
            input: 'speech',
            language: 'fr-FR',
            speechTimeout: 2,
            timeout: 6, // Augmenté à 6 secondes
            action: '/process-speech',
            method: 'POST',
            speechModel: 'experimental_conversations',
            enhanced: true,
            profanityFilter: false
        });
        
        // FALLBACK si pas de réponse - message poli
        twiml.say({ voice: 'alice', language: 'fr-FR' }, 
            'Merci pour votre appel. Un expert vous recontactera rapidement !');
        twiml.hangup();
        // ✅ DÉLAI UNIQUE pour fallback également  
        setTimeout(() => cleanupCall(callSid), 1000);
    }
    
    console.log(`⏱️ Réponse en ${Date.now() - startTime}ms`);
    res.type('text/xml');
    res.send(twiml.toString());
}

// Compte rendu d'appel AMÉLIORÉ
async function sendCallSummary(profile, conversation) {
    console.log('\n🔍 DÉBUT GÉNÉRATION COMPTE RENDU');
    
    // SÉCURISATION: vérifier que profile existe et a un téléphone
    if (!profile || !profile.phone) {
        console.error('❌ Profile invalide pour génération rapport:', profile);
        return;
    }
    
    const summary = generateLocalSummary(profile, conversation);
    const fs = require('fs');
    const path = require('path');
    
    // TOUJOURS créer le fichier local
    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
        console.log('📁 Dossier reports créé');
    }
    
    const timestamp = Date.now();
    const phoneClean = profile.phone.replace('+', '').replace(/\s/g, '');
    
    // Fichier JSON
    const jsonFileName = `call_${phoneClean}_${timestamp}.json`;
    const jsonFilePath = path.join(reportsDir, jsonFileName);
    
    try {
        fs.writeFileSync(jsonFilePath, JSON.stringify(summary, null, 2));
        console.log(`✅ Rapport JSON: ${jsonFileName}`);
    } catch (e) {
        console.error('❌ Erreur JSON:', e.message);
    }
    
    // Fichier TXT lisible
    const txtFileName = `call_${phoneClean}_${timestamp}.txt`;
    const txtFilePath = path.join(reportsDir, txtFileName);
    
    const duration = Math.round((Date.now() - profile.startTime) / 1000);
    const readableContent = generateReadableReport(profile, conversation, duration);
    
    try {
        fs.writeFileSync(txtFilePath, readableContent);
        console.log(`✅ Rapport TXT: ${txtFileName}`);
    } catch (e) {
        console.error('❌ Erreur TXT:', e.message);
    }
    
    // ENVOI EMAIL si configuré
    if (emailTransporter) {
        try {
            console.log('📧 Envoi email...');
            
            const leadStatus = (profile.email || profile.rdvRequested) ? '📅 RDV DEMANDÉ' : 'PROSPECT';
            
            await emailTransporter.sendMail({
                from: `"Dynophone" <${process.env.EMAIL_USER}>`,
                to: process.env.REPORT_EMAIL || process.env.EMAIL_USER,
                subject: `[${leadStatus}] Appel ${profile.phone}`,
                text: readableContent,
                html: readableContent.replace(/\n/g, '<br>'),
                attachments: [{
                    filename: jsonFileName,
                    path: jsonFilePath
                }]
            });
            
            console.log(`✅ EMAIL ENVOYÉ avec succès !`);
            
        } catch (error) {
            console.error(`❌ ERREUR EMAIL:`, error.message);
            if (error.code === 'EAUTH') {
                console.error('💡 Générer un mot de passe d\'application Gmail');
            }
        }
    } else {
        console.log('⚠️ Email non configuré - rapport local seulement');
    }
    
    console.log('🔍 FIN GÉNÉRATION COMPTE RENDU');
}

function generateReadableReport(profile, conversation, duration) {
    return `
📞 RAPPORT DYNOVATE - ${new Date().toLocaleString('fr-FR')}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📱 CONTACT
━━━━━━━━━━
• Téléphone: ${profile.phone}
• Email: ${profile.email || '❌ NON COLLECTÉ'}
• Secteur: ${profile.sector || 'Non identifié'}

📅 RENDEZ-VOUS
━━━━━━━━━━━━━━
• Demandé: ${profile.rdvRequested ? 'OUI ✅' : 'NON ❌'}
• Date souhaitée: ${profile.rdvDate || 'Non spécifiée'}
• Confirmé: ${profile.rdvConfirmed ? 'OUI ✅' : 'NON ❌'}

⏱️ STATISTIQUES
━━━━━━━━━━━━━━━
• Durée: ${duration}s (${Math.round(duration/60)}min)
• Échanges: ${profile.interactions || 0}
• Lead qualifié: ${(profile.email || profile.rdvRequested) ? 'OUI ✅' : 'NON ❌'}

🎯 ACTIONS PRIORITAIRES
━━━━━━━━━━━━━━━━━━━━━
${!profile.email && profile.rdvRequested ? '🔴 OBTENIR EMAIL pour envoi lien RDV\n' : ''}
${profile.rdvRequested && profile.rdvDate ? '📅 ENVOYER LIEN CALENDLY: ' + (process.env.CALENDLY_LINK || 'https://calendly.com/martin-bouvet-dynovate') + '\n' : ''}
${!profile.rdvRequested ? '📞 RELANCER pour proposer démo\n' : ''}
${!profile.sector ? '⚠️ IDENTIFIER le secteur d\'activité\n' : '✅ Secteur: ' + profile.sector + '\n'}

📋 CONVERSATION
━━━━━━━━━━━━━━━━
${conversation.map((msg, index) => 
    `${index + 1}. ${msg.role === 'user' ? '👤 CLIENT' : '🤖 DYNOPHONE'}: ${msg.content}`
).join('\n\n')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📧 Rapport automatique Dynovate AI
🔗 ${process.env.CALENDLY_LINK || 'https://calendly.com/martin-bouvet-dynovate'}
    `;
}

function generateLocalSummary(profile, conversation) {
    const duration = Math.round((Date.now() - profile.startTime) / 1000);
    
    return {
        timestamp: new Date().toISOString(),
        phone: profile.phone,
        email: profile.email || null,
        sector: profile.sector || null,
        duration: `${duration}s`,
        interactions: profile.interactions || 0,
        rdvRequested: profile.rdvRequested || false,
        rdvDate: profile.rdvDate || null,
        rdvConfirmed: profile.rdvConfirmed || false,
        qualified: !!(profile.email || profile.rdvRequested),
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
    
    // Extraction secteur
    const sectors = [
        { keywords: ['restaurant', 'café', 'bar', 'hôtel', 'restauration'], name: 'Restauration' },
        { keywords: ['immobilier', 'agence', 'location', 'vente', 'propriété'], name: 'Immobilier' },
        { keywords: ['commerce', 'boutique', 'magasin', 'retail'], name: 'Commerce' },
        { keywords: ['médical', 'médecin', 'cabinet', 'santé', 'docteur', 'clinique'], name: 'Santé' },
        { keywords: ['garage', 'automobile', 'voiture', 'mécanique'], name: 'Automobile' },
        { keywords: ['avocat', 'notaire', 'juridique', 'droit'], name: 'Juridique' },
        { keywords: ['informatique', 'tech', 'développement', 'logiciel'], name: 'Tech' }
    ];
    
    for (const sector of sectors) {
        if (sector.keywords.some(keyword => lowerSpeech.includes(keyword))) {
            profile.sector = sector.name;
            console.log(`🏢 Secteur identifié: ${profile.sector}`);
            break;
        }
    }
    
    userProfiles.set(callSid, profile);
}

async function cleanupCall(callSid) {
    // ✅ PROTECTION ANTI-DOUBLONS
    if (processedCalls.has(callSid)) {
        console.log(`⚠️ Appel ${callSid} déjà traité, ignorer`);
        return;
    }
    
    const profile = userProfiles.get(callSid);
    const conversation = conversations.get(callSid) || [];
    
    // SÉCURISATION: vérifier que profile existe avant traitement
    if (profile && profile.interactions > 0 && profile.phone) {
        // ✅ MARQUER COMME TRAITÉ AVANT GÉNÉRATION RAPPORT
        processedCalls.add(callSid);
        
        const duration = Math.round((Date.now() - profile.startTime) / 1000);
        console.log(`📊 Fin appel - ${duration}s, ${profile.interactions} échanges`);
        
        await sendCallSummary(profile, conversation);
        
        const leadType = (profile.email || profile.rdvRequested) ? 'LEAD QUALIFIÉ' : 'PROSPECT';
        console.log(`💰 ${leadType}: RDV=${profile.rdvRequested || false} - Secteur=${profile.sector || 'N/A'}`);
    } else {
        console.log(`⚠️ Profile invalide pour ${callSid}, nettoyage simple`);
        processedCalls.add(callSid); // Marquer même les appels invalides
    }
    
    conversations.delete(callSid);
    userProfiles.delete(callSid);
}

function sendFallbackResponse(res, twiml, callSid) {
    console.log(`🚨 Fallback: ${callSid}`);
    
    const gather = twiml.gather({
        input: 'speech',
        language: 'fr-FR',
        speechTimeout: 2,
        timeout: 4,
        action: '/process-speech',
        method: 'POST'
    });
    
    gather.say({ voice: 'alice', language: 'fr-FR' }, 'Je vous écoute.');
    
    twiml.say({ voice: 'alice', language: 'fr-FR' }, 
        'Merci de nous avoir contacté. Un expert vous rappellera.');
    twiml.hangup();
    
    res.type('text/xml');
    res.send(twiml.toString());
}

// ENDPOINT RAPPORTS avec authentification
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dynovate2024';

function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    
    if (!auth || !auth.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Rapports Dynovate"');
        return res.status(401).send('Authentification requise');
    }
    
    const credentials = Buffer.from(auth.slice(6), 'base64').toString();
    const [username, password] = credentials.split(':');
    
    if (username === 'admin' && password === ADMIN_PASSWORD) {
        next();
    } else {
        res.setHeader('WWW-Authenticate', 'Basic realm="Rapports Dynovate"');
        res.status(401).send('Identifiants incorrects');
    }
}

app.get('/rapports', requireAuth, (req, res) => {
    const fs = require('fs');
    const path = require('path');
    
    const reportsDir = path.join(process.cwd(), 'reports');
    
    if (!fs.existsSync(reportsDir)) {
        return res.send(generateEmptyReportsPage());
    }
    
    try {
        const files = fs.readdirSync(reportsDir)
            .filter(file => file.endsWith('.txt'))
            .sort((a, b) => {
                const statA = fs.statSync(path.join(reportsDir, a));
                const statB = fs.statSync(path.join(reportsDir, b));
                return statB.mtime - statA.mtime;
            });
        
        res.send(generateReportsPage(files, reportsDir));
        
    } catch (error) {
        res.send(generateErrorPage(error.message));
    }
});

// Endpoint pour télécharger un rapport
app.get('/rapports/download/:filename', requireAuth, (req, res) => {
    const fs = require('fs');
    const path = require('path');
    
    const filename = req.params.filename;
    const filePath = path.join(process.cwd(), 'reports', filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('Rapport non trouvé');
    }
    
    try {
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        
        const content = fs.readFileSync(filePath, 'utf8');
        res.send(content);
    } catch (error) {
        res.status(500).send('Erreur de téléchargement');
    }
});

function generateReportsPage(files, reportsDir) {
    const fs = require('fs');
    const path = require('path');
    
    const totalReports = files.length;
    
    let reportCards = '';
    
    files.forEach((file, index) => {
        const filePath = path.join(reportsDir, file);
        const stats = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        
        // Extraire les infos principales du rapport
        const phoneMatch = content.match(/Téléphone: (.*)/);
        const emailMatch = content.match(/Email: (.*)/);
        const rdvMatch = content.match(/Demandé: (.*)/);
        const durationMatch = content.match(/Durée: (\d+)s/);
        
        const phone = phoneMatch ? phoneMatch[1] : 'N/A';
        const email = emailMatch ? emailMatch[1] : 'N/A';
        const rdv = rdvMatch ? rdvMatch[1] : 'N/A';
        const duration = durationMatch ? Math.round(parseInt(durationMatch[1])/60) : 0;
        
        const isQualified = !email.includes('NON COLLECTÉ') || rdv.includes('OUI');
        
        reportCards += `
            <div class="report-card ${isQualified ? 'qualified' : ''}">
                <div class="report-header">
                    <div class="report-title">
                        <h3>📞 Appel #${totalReports - index}</h3>
                        <span class="badge ${isQualified ? 'badge-success' : 'badge-neutral'}">${isQualified ? 'LEAD QUALIFIÉ' : 'PROSPECT'}</span>
                    </div>
                    <div class="report-date">${stats.mtime.toLocaleString('fr-FR')}</div>
                </div>
                
                <div class="report-summary">
                    <div class="summary-item">
                        <span class="label">📱 Téléphone:</span>
                        <span class="value">${phone}</span>
                    </div>
                    <div class="summary-item">
                        <span class="label">📧 Email:</span>
                        <span class="value ${email.includes('NON') ? 'missing' : ''}">${email}</span>
                    </div>
                    <div class="summary-item">
                        <span class="label">⏱️ Durée:</span>
                        <span class="value">${duration} min</span>
                    </div>
                    <div class="summary-item">
                        <span class="label">📅 RDV:</span>
                        <span class="value ${rdv.includes('OUI') ? 'success' : ''}">${rdv}</span>
                    </div>
                </div>
                
                <div class="report-actions">
                    <button class="btn btn-primary" onclick="toggleReport('${file}')">
                        <span id="toggle-${file}">👁️ Voir détails</span>
                    </button>
                    <a href="/rapports/download/${file}" class="btn btn-secondary">
                        💾 Télécharger
                    </a>
                </div>
                
                <div id="content-${file}" class="report-content" style="display: none;">
                    <pre>${content}</pre>
                </div>
            </div>
        `;
    });
    
    return `
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Rapports Dynovate - Assistant IA</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                
                body {
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    padding: 20px;
                }
                
                .container {
                    max-width: 1200px;
                    margin: 0 auto;
                    background: white;
                    border-radius: 15px;
                    box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                    overflow: hidden;
                }
                
                .header {
                    background: linear-gradient(45deg, #2C3E50, #3498DB);
                    color: white;
                    padding: 30px;
                    text-align: center;
                }
                
                .header h1 {
                    font-size: 2.5em;
                    margin-bottom: 10px;
                    font-weight: 300;
                }
                
                .header p {
                    font-size: 1.2em;
                    opacity: 0.9;
                }
                
                .stats {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 20px;
                    padding: 30px;
                    background: #f8f9fa;
                    border-bottom: 1px solid #dee2e6;
                }
                
                .stat-card {
                    background: white;
                    padding: 20px;
                    border-radius: 10px;
                    text-align: center;
                    box-shadow: 0 5px 15px rgba(0,0,0,0.1);
                }
                
                .stat-number {
                    font-size: 2em;
                    font-weight: bold;
                    color: #2C3E50;
                    margin-bottom: 5px;
                }
                
                .stat-label {
                    color: #6c757d;
                    font-size: 0.9em;
                    text-transform: uppercase;
                    letter-spacing: 1px;
                }
                
                .reports-container {
                    padding: 30px;
                }
                
                .report-card {
                    background: white;
                    border: 1px solid #dee2e6;
                    border-radius: 10px;
                    margin-bottom: 20px;
                    transition: transform 0.2s, box-shadow 0.2s;
                }
                
                .report-card:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 10px 25px rgba(0,0,0,0.1);
                }
                
                .report-card.qualified {
                    border-left: 5px solid #28a745;
                }
                
                .report-header {
                    padding: 20px;
                    border-bottom: 1px solid #eee;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                
                .report-title {
                    display: flex;
                    align-items: center;
                    gap: 15px;
                }
                
                .report-title h3 {
                    color: #2C3E50;
                    margin: 0;
                }
                
                .badge {
                    padding: 5px 12px;
                    border-radius: 20px;
                    font-size: 0.8em;
                    font-weight: bold;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                
                .badge-success {
                    background: #d4edda;
                    color: #155724;
                }
                
                .badge-neutral {
                    background: #e2e3e5;
                    color: #383d41;
                }
                
                .report-date {
                    color: #6c757d;
                    font-size: 0.9em;
                }
                
                .report-summary {
                    padding: 20px;
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                    gap: 15px;
                }
                
                .summary-item {
                    display: flex;
                    justify-content: space-between;
                    padding: 10px;
                    background: #f8f9fa;
                    border-radius: 5px;
                }
                
                .label {
                    font-weight: bold;
                    color: #495057;
                }
                
                .value {
                    color: #2C3E50;
                }
                
                .value.missing {
                    color: #dc3545;
                    font-style: italic;
                }
                
                .value.success {
                    color: #28a745;
                    font-weight: bold;
                }
                
                .report-actions {
                    padding: 20px;
                    border-top: 1px solid #eee;
                    display: flex;
                    gap: 10px;
                }
                
                .btn {
                    padding: 10px 20px;
                    border: none;
                    border-radius: 5px;
                    text-decoration: none;
                    font-weight: bold;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                
                .btn-primary {
                    background: #007bff;
                    color: white;
                }
                
                .btn-primary:hover {
                    background: #0056b3;
                }
                
                .btn-secondary {
                    background: #6c757d;
                    color: white;
                }
                
                .btn-secondary:hover {
                    background: #545b62;
                }
                
                .report-content {
                    padding: 20px;
                    background: #f8f9fa;
                    border-top: 1px solid #eee;
                }
                
                .report-content pre {
                    white-space: pre-wrap;
                    font-family: 'Courier New', monospace;
                    font-size: 0.9em;
                    color: #2C3E50;
                    background: white;
                    padding: 20px;
                    border-radius: 5px;
                    border-left: 4px solid #007bff;
                    overflow-x: auto;
                }
                
                .footer {
                    background: #2C3E50;
                    color: white;
                    text-align: center;
                    padding: 20px;
                    font-size: 0.9em;
                }
                
                @media (max-width: 768px) {
                    .report-header {
                        flex-direction: column;
                        gap: 10px;
                        text-align: center;
                    }
                    
                    .report-summary {
                        grid-template-columns: 1fr;
                    }
                    
                    .report-actions {
                        flex-direction: column;
                    }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🤖 Dynovate Assistant IA</h1>
                    <p>Rapports d'appels et analyse des leads</p>
                </div>
                
                <div class="stats">
                    <div class="stat-card">
                        <div class="stat-number">${totalReports}</div>
                        <div class="stat-label">Appels totaux</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${files.filter(file => {
                            const content = fs.readFileSync(path.join(reportsDir, file), 'utf8');
                            return content.includes('LEAD QUALIFIÉ') || content.includes('OUI ✅');
                        }).length}</div>
                        <div class="stat-label">Leads qualifiés</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${files.filter(file => {
                            const content = fs.readFileSync(path.join(reportsDir, file), 'utf8');
                            return content.includes('Demandé: OUI');
                        }).length}</div>
                        <div class="stat-label">RDV demandés</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${new Date().toLocaleDateString('fr-FR')}</div>
                        <div class="stat-label">Dernière maj</div>
                    </div>
                </div>
                
                <div class="reports-container">
                    ${totalReports === 0 ? '<p style="text-align: center; color: #6c757d; font-size: 1.1em;">Aucun rapport d\'appel trouvé.</p>' : reportCards}
                </div>
                
                <div class="footer">
                    <p>© 2024 Dynovate - Assistant IA Téléphonique | Données confidentielles</p>
                </div>
            </div>
            
            <script>
                function toggleReport(filename) {
                    const content = document.getElementById('content-' + filename);
                    const toggle = document.getElementById('toggle-' + filename);
                    
                    if (content.style.display === 'none') {
                        content.style.display = 'block';
                        toggle.textContent = '🙈 Masquer détails';
                    } else {
                        content.style.display = 'none';
                        toggle.textContent = '👁️ Voir détails';
                    }
                }
            </script>
        </body>
        </html>
    `;
}

function generateEmptyReportsPage() {
    return `
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Rapports Dynovate</title>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin: 0;
                }
                .container {
                    background: white;
                    padding: 40px;
                    border-radius: 15px;
                    text-align: center;
                    box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 Dynovate Assistant IA</h1>
                <p>Aucun rapport d'appel trouvé.</p>
                <p>Les rapports apparaîtront ici après les premiers appels.</p>
            </div>
        </body>
        </html>
    `;
}

function generateErrorPage(error) {
    return `
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <title>Erreur - Rapports Dynovate</title>
        </head>
        <body>
            <h1>Erreur</h1>
            <p>Une erreur est survenue: ${error}</p>
        </body>
        </html>
    `;
}

// Endpoint de santé
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK',
        timestamp: new Date().toISOString(),
        features: {
            elevenlabs: USE_ELEVENLABS && !!ELEVENLABS_API_KEY,
            email: !!emailTransporter,
            groq: !!process.env.GROQ_API_KEY
        },
        stats: {
            activeConversations: conversations.size,
            userProfiles: userProfiles.size
        },
        env: {
            EMAIL_USER: process.env.EMAIL_USER ? 'CONFIGURÉ' : 'MANQUANT',
            EMAIL_PASS: process.env.EMAIL_PASS ? 'CONFIGURÉ' : 'MANQUANT',
            CALENDLY_LINK: process.env.CALENDLY_LINK ? 'CONFIGURÉ' : 'MANQUANT',
            ADMIN_PASSWORD: ADMIN_PASSWORD !== 'dynovate2024' ? 'PERSONNALISÉ' : 'DÉFAUT'
        }
    });
});

// Nettoyage automatique des sessions anciennes + PROTECTION DOUBLONS
setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    
    for (const [callSid, profile] of userProfiles.entries()) {
        if (now - profile.startTime > maxAge) {
            console.log(`🧹 Nettoyage session expirée: ${callSid}`);
            cleanupCall(callSid);
        }
    }
    
    // Nettoyage cache audio
    if (Object.keys(global.audioQueue).length > 50) {
        console.log('🧹 Nettoyage cache audio');
        global.audioQueue = {};
    }
    
    // ✅ NOUVEAU: Nettoyage des appels traités (garde seulement les 100 derniers)
    if (processedCalls.size > 100) {
        console.log('🧹 Nettoyage cache processedCalls');
        const callsArray = Array.from(processedCalls);
        const toKeep = callsArray.slice(-50); // Garder les 50 derniers
        processedCalls.clear();
        toKeep.forEach(call => processedCalls.add(call));
    }
}, 10 * 60 * 1000); // Toutes les 10 minutes

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
🚀 DYNOVATE ASSISTANT IA - VERSION OPTIMISÉE ✅
⚡ Port: ${PORT}
    
✅ CORRECTIONS APPLIQUÉES:
📧 Email: ${emailTransporter ? 'CONFIGURÉ ✅' : 'NON CONFIGURÉ ❌'}
💬 Réponses courtes sans troncature
📊 Interface rapports accessible sur /rapports
🔄 Fin d'appel naturelle améliorée
    
📧 CONFIGURATION EMAIL:
- USER: ${process.env.EMAIL_USER || 'MANQUANT'}
- PASS: ${process.env.EMAIL_PASS ? 'CONFIGURÉ' : 'MANQUANT'}
- DEST: ${process.env.REPORT_EMAIL || 'DÉFAUT'}
    
🎯 FONCTIONNALITÉS ACTIVES:
${USE_ELEVENLABS && ELEVENLABS_API_KEY ? '🎵 Voix ElevenLabs activée' : '🔊 Voix Twilio Alice'}
📁 Rapports automatiques JSON + TXT
🚀 IA Groq Llama 3.3 70B optimisée
📅 Capture RDV intelligente
🔒 Interface sécurisée (admin:${ADMIN_PASSWORD})
    
📊 ACCÈS RAPPORTS:
https://votre-domaine.railway.app/rapports
Identifiants: admin / ${ADMIN_PASSWORD}
    
🎯 PROCHAINES ÉTAPES:
1. Tester avec vrais appels
2. Corriger configuration email Gmail
3. Préparer pitch deck entreprise
    `);
    
    // Test des APIs externes
    if (ELEVENLABS_API_KEY) {
        axios.get('https://api.elevenlabs.io/v1/user', {
            headers: { 'xi-api-key': ELEVENLABS_API_KEY }
        }).then(response => {
            const usage = response.data.subscription;
            console.log(`💳 ElevenLabs: ${usage.character_count}/${usage.character_limit} caractères utilisés`);
        }).catch(err => {
            console.log('⚠️ ElevenLabs API inaccessible');
        });
    }
});