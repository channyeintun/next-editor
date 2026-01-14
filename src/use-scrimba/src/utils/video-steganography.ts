/**
 * MAGIC_PREFIX is used to identify Scrimba data in videos.
 */
export const MAGIC_PREFIX = 'SCRIMBA_v1:';

type VideoStyle = 'gradient' | 'particles' | 'waves' | 'geometric' | 'pulse';

interface VideoEncodingResult {
    videoBlob: Blob;
    duration: number;
}

/**
 * Encodes data into a video file using LSB steganography across frames.
 * @param data The string data to encode.
 * @param style The visual style of the video.
 * @param title Optional title to display in the video.
 * @returns Promise with the video blob and duration.
 */
export async function encodeDataInVideo(
    data: string,
    style: VideoStyle = 'gradient',
    title: string = ''
): Promise<VideoEncodingResult> {
    // Add magic prefix to data
    const dataToEncode = MAGIC_PREFIX + data;
    const binaryData = stringToBinary(dataToEncode);
    const dataLength = binaryData.length;
    const lengthBinary = dataLength.toString(2).padStart(32, '0');

    // Calculate video dimensions and frame count
    const frameWidth = 640;
    const frameHeight = 480;
    const bitsPerFrame = frameWidth * frameHeight * 3;
    const bitsNeeded = dataLength + 32; // +32 for length header
    const framesNeeded = Math.ceil(bitsNeeded / bitsPerFrame);
    const totalFrames = Math.max(30, framesNeeded); // Minimum 1 second at 30fps
    const fps = 30;
    const duration = totalFrames / fps;

    // Create canvas for drawing frames
    const canvas = document.createElement('canvas');
    canvas.width = frameWidth;
    canvas.height = frameHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');

    // Setup MediaRecorder
    const stream = canvas.captureStream(fps);
    const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp8',
        videoBitsPerSecond: 8000000 // 8 Mbps
    });

    const chunks: Blob[] = [];
    
    return new Promise((resolve, reject) => {
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                chunks.push(e.data);
            }
        };

        mediaRecorder.onstop = () => {
            const blob = new Blob(chunks, { type: 'video/webm' });
            resolve({ videoBlob: blob, duration });
        };

        mediaRecorder.onerror = (e) => {
            reject(new Error('MediaRecorder error: ' + e));
        };

        mediaRecorder.start();

        // Generate and encode frames
        let globalBitIndex = 0;
        let frameIndex = 0;

        const generateFrame = () => {
            if (frameIndex >= totalFrames) {
                mediaRecorder.stop();
                return;
            }

            // Draw background
            drawFrame(ctx, frameWidth, frameHeight, frameIndex, totalFrames, style);

            // Add title if provided
            if (title) {
                addTitle(ctx, frameWidth, frameHeight, title);
            }

            // Get frame data and encode
            const imageData = ctx.getImageData(0, 0, frameWidth, frameHeight);
            const pixels = imageData.data;

            let localBitIndex = 0;
            const maxBitsThisFrame = frameWidth * frameHeight * 3;

            while (localBitIndex < maxBitsThisFrame && globalBitIndex < bitsNeeded) {
                const pixelIndex = Math.floor(localBitIndex / 3) * 4;
                const colorChannel = localBitIndex % 3;

                let bit: number;
                if (globalBitIndex < 32) {
                    // Encode length header
                    bit = parseInt(lengthBinary[globalBitIndex]);
                } else if (globalBitIndex - 32 < dataLength) {
                    // Encode actual data
                    bit = parseInt(binaryData[globalBitIndex - 32]);
                } else {
                    break;
                }

                pixels[pixelIndex + colorChannel] = (pixels[pixelIndex + colorChannel] & 0xFE) | bit;
                localBitIndex++;
                globalBitIndex++;
            }

            ctx.putImageData(imageData, 0, 0);

            frameIndex++;
            setTimeout(generateFrame, 33); // ~30fps
        };

        generateFrame();
    });
}

/**
 * Decodes data from a video file.
 * @param videoElement The video element containing the encoded video.
 * @returns Promise with the decoded string, or null if no valid data found.
 */
export async function decodeDataFromVideo(videoElement: HTMLVideoElement): Promise<string | null> {
    // Wait for video to be fully ready
    if (videoElement.readyState < 2) {
        await new Promise<void>((resolve) => {
            const handler = () => {
                videoElement.removeEventListener('loadeddata', handler);
                resolve();
            };
            videoElement.addEventListener('loadeddata', handler);
        });
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;

    // Validate dimensions
    if (canvas.width === 0 || canvas.height === 0) {
        console.error('Invalid video dimensions');
        return null;
    }

    const fps = 30;
    const duration = videoElement.duration;
    
    // Validate duration
    if (!isFinite(duration) || duration <= 0) {
        console.error('Invalid video duration');
        return null;
    }

    const totalFrames = Math.ceil(duration * fps);

    let binaryData = '';
    let dataLength = 0;
    let lengthRead = false;
    let globalBitIndex = 0;

    // Seek to start
    videoElement.currentTime = 0;
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Seek timeout')), 5000);
        const handler = () => {
            clearTimeout(timeout);
            videoElement.removeEventListener('seeked', handler);
            resolve();
        };
        videoElement.addEventListener('seeked', handler);
    });

    for (let frame = 0; frame < totalFrames; frame++) {
        // Seek to frame
        const targetTime = frame / fps;
        videoElement.currentTime = targetTime;
        
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Frame seek timeout')), 3000);
            const handler = () => {
                clearTimeout(timeout);
                videoElement.removeEventListener('seeked', handler);
                resolve();
            };
            videoElement.addEventListener('seeked', handler);
        });

        // Draw frame to canvas
        ctx.drawImage(videoElement, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = imageData.data;

        const maxBitsThisFrame = canvas.width * canvas.height * 3;
        let localBitIndex = 0;

        while (localBitIndex < maxBitsThisFrame) {
            const pixelIndex = Math.floor(localBitIndex / 3) * 4;
            const colorChannel = localBitIndex % 3;
            const bit = (pixels[pixelIndex + colorChannel] & 1).toString();

            if (!lengthRead) {
                if (globalBitIndex < 32) {
                    binaryData += bit;
                    globalBitIndex++;

                    if (globalBitIndex === 32) {
                        dataLength = parseInt(binaryData, 2);
                        
                        // Sanity check
                        if (isNaN(dataLength) || dataLength <= 0 || dataLength > pixels.length * totalFrames * 3) {
                            console.error('Invalid data length detected:', dataLength);
                            return null;
                        }
                        
                        binaryData = '';
                        lengthRead = true;
                    }
                }
            } else {
                binaryData += bit;
                globalBitIndex++;

                if (binaryData.length === dataLength) {
                    const decoded = binaryToString(binaryData);
                    
                    if (decoded.startsWith(MAGIC_PREFIX)) {
                        return decoded.substring(MAGIC_PREFIX.length);
                    }
                    console.error('Decoded data missing magic prefix');
                    return null;
                }
            }

            localBitIndex++;
        }
    }

    console.error('Reached end of video without finding complete data');
    return null;
}

/**
 * Draw a frame with the specified style.
 */
function drawFrame(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    frameNum: number,
    totalFrames: number,
    style: VideoStyle
): void {
    const progress = frameNum / totalFrames;

    switch (style) {
        case 'gradient': {
            const gradient = ctx.createLinearGradient(0, 0, width, height);
            const hue1 = (progress * 360) % 360;
            const hue2 = ((progress * 360) + 120) % 360;
            gradient.addColorStop(0, `hsl(${hue1}, 70%, 60%)`);
            gradient.addColorStop(1, `hsl(${hue2}, 70%, 60%)`);
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, width, height);
            break;
        }

        case 'particles': {
            ctx.fillStyle = '#1a1a2e';
            ctx.fillRect(0, 0, width, height);
            for (let i = 0; i < 50; i++) {
                const x = ((i * 13 + frameNum * 2) % width);
                const y = ((i * 17 + frameNum * 3) % height);
                const size = 3 + (i % 5);
                ctx.fillStyle = `hsla(${(i * 30 + frameNum * 2) % 360}, 70%, 60%, 0.8)`;
                ctx.beginPath();
                ctx.arc(x, y, size, 0, Math.PI * 2);
                ctx.fill();
            }
            break;
        }

        case 'waves': {
            const waveGradient = ctx.createLinearGradient(0, 0, 0, height);
            waveGradient.addColorStop(0, '#667eea');
            waveGradient.addColorStop(1, '#764ba2');
            ctx.fillStyle = waveGradient;
            ctx.fillRect(0, 0, width, height);

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.lineWidth = 3;
            for (let i = 0; i < 5; i++) {
                ctx.beginPath();
                for (let x = 0; x < width; x += 5) {
                    const y = height / 2 + Math.sin((x / 50) + (frameNum / 10) + i) * 50;
                    if (x === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            break;
        }

        case 'geometric': {
            ctx.fillStyle = '#2c3e50';
            ctx.fillRect(0, 0, width, height);

            const numShapes = 10;
            for (let i = 0; i < numShapes; i++) {
                const angle = (frameNum / 30 + i / numShapes) * Math.PI * 2;
                const x = width / 2 + Math.cos(angle) * (width / 4);
                const y = height / 2 + Math.sin(angle) * (height / 4);
                const size = 30 + (i % 3) * 20;

                ctx.fillStyle = `hsla(${(i * 36 + frameNum * 3) % 360}, 70%, 60%, 0.7)`;
                ctx.fillRect(x - size / 2, y - size / 2, size, size);
            }
            break;
        }

        case 'pulse': {
            const radialGradient = ctx.createRadialGradient(
                width / 2, height / 2, 0,
                width / 2, height / 2, Math.max(width, height) / 2
            );
            const pulseProgress = (Math.sin(frameNum / 15) + 1) / 2;
            radialGradient.addColorStop(0, `hsl(${frameNum % 360}, 80%, ${40 + pulseProgress * 20}%)`);
            radialGradient.addColorStop(1, `hsl(${(frameNum + 60) % 360}, 80%, ${30 + pulseProgress * 15}%)`);
            ctx.fillStyle = radialGradient;
            ctx.fillRect(0, 0, width, height);
            break;
        }
    }
}

/**
 * Add title overlay to frame.
 */
function addTitle(ctx: CanvasRenderingContext2D, width: number, height: number, title: string): void {
    const overlayHeight = height * 0.25;
    const overlayY = (height - overlayHeight) / 2;

    const gradient = ctx.createLinearGradient(0, overlayY, 0, overlayY + overlayHeight);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
    gradient.addColorStop(0.5, 'rgba(0, 0, 0, 0.75)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, overlayY, width, overlayHeight);

    const fontSize = Math.min(48, width / 12);
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = 15;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 3;

    ctx.fillText(title, width / 2, height / 2);

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
}

function stringToBinary(str: string): string {
    return str.split('').map(char => {
        return char.charCodeAt(0).toString(2).padStart(8, '0');
    }).join('');
}

function binaryToString(binary: string): string {
    const bytes = binary.match(/.{8}/g);
    if (!bytes) return '';
    return bytes.map(byte => String.fromCharCode(parseInt(byte, 2))).join('');
}