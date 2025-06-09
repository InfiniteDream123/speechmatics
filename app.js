const API_KEY = 's5e0pwRElzdeu8LDm71GB6iuTq9OPJ0x';
const audioSourceSelect = document.getElementById('audioSource');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const transcriptionDiv = document.getElementById('transcription');

let mediaStream = null;
let audioContext = null;
let ws = null;
let isTranscribing = false;
let finalText = '';
let lastPartialSpan = null;

// Initialize audio sources
async function initializeAudioSources() {
    try {
        // Add system audio option
        const systemOption = document.createElement('option');
        systemOption.value = 'system';
        systemOption.text = 'System Audio (Speaker/Tabs)';
        audioSourceSelect.appendChild(systemOption);

        // Add microphone options
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(device => device.kind === 'audioinput');
        
        audioInputs.forEach(input => {
            const option = document.createElement('option');
            option.value = input.deviceId;
            option.text = input.label || `Microphone ${audioSourceSelect.length}`;
            audioSourceSelect.appendChild(option);
        });

        if (audioInputs.length > 0) {
            startButton.disabled = false;
        }
    } catch (error) {
        console.error('Error getting audio devices:', error);
    }
}

// Fetch JWT token from Speechmatics
async function fetchJWT() {
    try {
        const response = await fetch('https://mp.speechmatics.com/v1/api_keys?type=rt', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                ttl: 3600
            })
        });

        if (!response.ok) {
            throw new Error('Failed to fetch JWT');
        }

        const data = await response.json();
        return data.key_value;
    } catch (error) {
        console.error('Error fetching JWT:', error);
        throw error;
    }
}

// Initialize WebSocket connection
async function initializeWebSocket() {
    const jwt = await fetchJWT();
    ws = new WebSocket(`wss://eu2.rt.speechmatics.com/v2?jwt=${jwt}`);

    ws.onopen = () => {
        console.log('WebSocket connection established');
        // Send StartRecognition message
        const startMessage = {
            message: "StartRecognition",
            audio_format: {
                type: "raw",
                encoding: "pcm_f32le",
                sample_rate: 16000
            },
            transcription_config: {
                language: "en",
                enable_partials: true,
                max_delay: 2.0
            }
        };
        ws.send(JSON.stringify(startMessage));
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.message === 'AddPartialTranscript') {
            const partialText = data.results
                .map(r => r.alternatives?.[0].content)
                .join(' ');
            updateTranscription(partialText, true);
        } else if (data.message === 'AddTranscript') {
            const text = data.results
                .map(r => r.alternatives?.[0].content)
                .join(' ');
            finalText += text;
            updateTranscription(text, false);
        } else if (data.message === 'EndOfTranscript') {
            console.log('Transcription ended');
        } else if (data.message === 'Error') {
            console.error('Speechmatics error:', data);
            alert(`Error: ${data.reason}`);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        alert('WebSocket error occurred. Please check console for details.');
    };

    ws.onclose = () => {
        console.log('WebSocket connection closed');
        isTranscribing = false;
        startButton.disabled = false;
        stopButton.disabled = true;
    };
}

// Update transcription display
function updateTranscription(text, isPartial) {
    if (isPartial) {
        // Remove previous partial text if it exists
        if (lastPartialSpan) {
            lastPartialSpan.remove();
        }

        // Create new partial text span
        const span = document.createElement('span');
        span.textContent = text;
        span.style.opacity = '0.7';
        span.style.fontStyle = 'italic';
        lastPartialSpan = span;

        transcriptionDiv.appendChild(span);
    } else {
        // Remove the partial text since we now have the final version
        if (lastPartialSpan) {
            lastPartialSpan.remove();
            lastPartialSpan = null;
        }

        // Add the final text
        const span = document.createElement('span');
        span.textContent = text + ' ';
        transcriptionDiv.appendChild(span);
    }
    
    transcriptionDiv.scrollTop = transcriptionDiv.scrollHeight;
}

// Get audio stream based on selected source
async function getAudioStream() {
    const selectedSource = audioSourceSelect.value;
    
    if (selectedSource === 'system') {
        try {
            // First try with audio only
            const displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: false,
                audio: true
            });
            return displayStream;
        } catch (error) {
            console.log('Audio-only capture failed, trying with video:', error);
            try {
                // If audio-only fails, try with video (some browsers require this)
                const displayStream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true
                });
                // Remove video tracks since we only need audio
                displayStream.getVideoTracks().forEach(track => track.stop());
                return displayStream;
            } catch (error) {
                console.error('Failed to capture system audio:', error);
                throw new Error('Unable to capture system audio. Please make sure your browser supports audio capture and try again.');
            }
        }
    } else {
        try {
            // Request microphone capture with fallback options
            const constraints = {
                audio: {
                    deviceId: selectedSource ? { exact: selectedSource } : undefined,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            };

            try {
                return await navigator.mediaDevices.getUserMedia(constraints);
            } catch (error) {
                console.log('Failed with specific constraints, trying with basic audio:', error);
                // If specific constraints fail, try with basic audio
                return await navigator.mediaDevices.getUserMedia({ audio: true });
            }
        } catch (error) {
            console.error('Failed to capture microphone audio:', error);
            throw new Error('Unable to access microphone. Please make sure you have granted microphone permissions and try again.');
        }
    }
}

// Start transcription
async function startTranscription() {
    try {
        // Clear previous transcription
        transcriptionDiv.innerHTML = '';
        finalText = '';
        lastPartialSpan = null;

        mediaStream = await getAudioStream();
        
        // Create audio context with sample rate matching Speechmatics requirements
        audioContext = new AudioContext({
            sampleRate: 16000
        });
        
        const source = audioContext.createMediaStreamSource(mediaStream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);

        source.connect(processor);
        processor.connect(audioContext.destination);

        await initializeWebSocket();

        processor.onaudioprocess = (e) => {
            if (isTranscribing && ws && ws.readyState === WebSocket.OPEN) {
                const audioData = e.inputBuffer.getChannelData(0);
                ws.send(audioData);
            }
        };

        isTranscribing = true;
        startButton.disabled = true;
        stopButton.disabled = false;

        // Handle stream end (e.g., when user stops sharing screen)
        mediaStream.getVideoTracks().forEach(track => {
            track.onended = () => {
                stopTranscription();
            };
        });

        // Handle audio track end
        mediaStream.getAudioTracks().forEach(track => {
            track.onended = () => {
                stopTranscription();
            };
        });
    } catch (error) {
        console.error('Error starting transcription:', error);
        alert(error.message || 'Error starting transcription. Please check console for details.');
        stopTranscription();
    }
}

// Stop transcription
async function stopTranscription() {
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }
    
    if (audioContext) {
        await audioContext.close();
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        const endMessage = {
            message: "EndOfStream",
            last_seq_no: 0
        };
        ws.send(JSON.stringify(endMessage));
        ws.close();
    }

    isTranscribing = false;
    startButton.disabled = false;
    stopButton.disabled = true;
    finalText = '';
    lastPartialSpan = null;
}

// Event listeners
startButton.addEventListener('click', startTranscription);
stopButton.addEventListener('click', stopTranscription);

// Initialize the application
initializeAudioSources(); 