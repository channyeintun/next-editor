- No need to run "npm run dev". I'll do it. Just ask me.
- No need to run "npm run build". I'll do it. Just ask me.
- The following is a complete perfect working demo. Please reimplement our existing packages/use-scrimba according to this one. No need to use jQuery. What important are:
1. use calculateDurationFromFileReader to calculate exact duration.
2. Must use Audio instead of audio element with ref
3. Must use timeupdate as single source of truth for audio and snapshots.
4. Do not use input type=range. It has issue and cannot display actual progress. Implement custom element to have the same UI as current.

```
<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Audio and Textarea Sync Demo</title>
    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
</head>

<body>
    <h1>Audio and Textarea Change Recording Demo</h1>
    <textarea id="textArea" rows="10" cols="50">Start typing here...</textarea><br>
    <button id="startBtn">Start Recording</button>
    <button id="stopBtn" disabled>Stop Recording</button>
    <button id="playBtn" disabled>Play</button>
    <div id="progressContainer" style="width: 300px; height: 20px; background-color: #ddd; cursor: pointer; position: relative;">
        <div id="progressBar" style="width: 0%; height: 100%; background-color: #4CAF50;"></div>
    </div>

    <script>
        let audioChunks = [];
        let mediaRecorder;
        let audioBlob;
        let audioUrl;
        let changes = [];
        let startTime;
        let audio;
        let recordingDuration = 0;
        let totalAudioSize = 0;

        // Duration calculation using FileReader
        async function calculateDurationFromFileReader(audioBlob) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                
                reader.onload = function(e) {
                    try {
                        const arrayBuffer = e.target.result;
                        const audioContext = new window.AudioContext();
                        
                        audioContext.decodeAudioData(
                            arrayBuffer,
                            buffer => {
                                const rawDuration = buffer.duration;
                                const adjustedDuration = rawDuration - 0.06; // Subtract 0.06s for exact end time
                                console.log('FileReader raw duration:', rawDuration, 'seconds');
                                console.log('Adjusted duration:', adjustedDuration, 'seconds');
                                audioContext.close();
                                resolve(adjustedDuration);
                            },
                            error => {
                                console.error('FileReader decode error:', error);
                                audioContext.close();
                                reject(error);
                            }
                        );
                    } catch (error) {
                        console.error('FileReader processing error:', error);
                        reject(error);
                    }
                };
                
                reader.onerror = function() {
                    console.error('FileReader read error');
                    reject(new Error('FileReader failed'));
                };
                
                reader.readAsArrayBuffer(audioBlob);
            });
        }

        $('#startBtn').click(async () => {
            changes = [];
            audioChunks = [];
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        autoGainControl: true,
                        echoCancellation: true,
                        noiseSuppression: true,
                        channelCount: 1,
                        sampleRate: 48000,
                    }
                });
                // Check for supported formats that provide duration metadata
                let mimeType = "audio/webm; codecs=opus";

                mediaRecorder = new MediaRecorder(stream, {
                    audioBitsPerSecond: 48000,
                    mimeType: mimeType,
                });
                mediaRecorder.ondataavailable = e => {
                    audioChunks.push(e.data);
                };
                mediaRecorder.onstop = async () => {
                    audioBlob = new Blob(audioChunks, { type: mimeType });
                    audioUrl = URL.createObjectURL(audioBlob);

                    // Calculate duration using FileReader approach
                    try {
                        recordingDuration = await calculateDurationFromFileReader(audioBlob);
                        console.log('Final duration used:', recordingDuration, 'seconds');
                        // Progress bar max is now handled by percentage calculation
                    } catch (error) {
                        console.error('Failed to calculate duration:', error);
                        recordingDuration = 0;
                    }

                    $('#playBtn').prop('disabled', false);
                };
                mediaRecorder.start();
                startTime = performance.now();
                changes.push({ time: 0, value: $('#textArea').val() });
                $('#startBtn').prop('disabled', true);
                $('#stopBtn').prop('disabled', false);
            } catch (err) {
                console.error('Error accessing microphone:', err);
            }
        });

        $('#stopBtn').click(() => {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
            }
            $('#stopBtn').prop('disabled', true);
            $('#startBtn').prop('disabled', false);
        });

        $('#textArea').on('input', () => {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                const time = performance.now() - startTime;
                changes.push({ time: time, value: $('#textArea').val() });
            }
        });

        $('#playBtn').click(() => {
            if (audio) {
                audio.pause();
            }
            audio = new Audio(audioUrl);
            $('#progressContainer').show();

            audio.onloadedmetadata = () => {
                audio._actualDuration = recordingDuration;
                console.log('Setting audio._actualDuration:', recordingDuration);
            };

            if (changes.length > 0) {
                $('#textArea').val(changes[0].value);
            }
            audio.play();

            audio.ontimeupdate = (e) => {
                console.log('currentTime:', audio.currentTime);
                const currentTimeMs = audio.currentTime * 1000;
                
                // Update progress bar as percentage
                const percentage = (audio.currentTime / audio._actualDuration) * 100;
                $('#progressBar').css('width', percentage + '%');

                for (let i = changes.length - 1; i >= 0; i--) {
                    if (changes[i].time <= currentTimeMs) {
                        $('#textArea').val(changes[i].value);
                        break;
                    }
                }
            };

            audio.onended = () => {
                $('#playBtn').prop('disabled', false);
            };
        });


        $('#progressContainer').on('click', (e) => {
            if (audio && audio._actualDuration) {
                const containerWidth = $('#progressContainer').width();
                const clickX = e.offsetX;
                const percentage = clickX / containerWidth;
                const seekTime = percentage * audio._actualDuration;
                
                audio.currentTime = seekTime;
                const currentTimeMs = seekTime * 1000;
                
                // Update textarea immediately when seeking
                for (let i = changes.length - 1; i >= 0; i--) {
                    if (changes[i].time <= currentTimeMs) {
                        $('#textArea').val(changes[i].value);
                        break;
                    }
                }
                
                if (audio.paused) {
                    audio.play();
                }
            }
        });
    </script>
</body>

</html>

```