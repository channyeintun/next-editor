import React, { useState } from 'react';
import type { Recording } from '../use-scrimba/src';
import { encodeDataInCanvas } from '../use-scrimba/src/utils/steganography';

interface ScrimbaImageSaveModalProps {
    recording: Recording;
    isVisible: boolean;
    onSave: (file: File) => void;
    onCancel: () => void;
    initialText?: string;
}

type ImageStyle = 'gradient' | 'pixelated' | 'abstract' | 'noise' | 'geometric';

const ScrimbaImageSaveModal: React.FC<ScrimbaImageSaveModalProps> = ({
    recording,
    isVisible,
    onSave,
    onCancel,
    initialText
}) => {
    const [imageTitle, setImageTitle] = useState('');
    const [imageStyle, setImageStyle] = useState<ImageStyle>('gradient');
    const [isGenerating, setIsGenerating] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);

    const generateImage = async (isManualDownload: boolean = false, shareToMastodon: boolean = false) => {
        if (!isVisible) return;
        setIsGenerating(true);
        try {
            // 1. Prepare data (Recording JSON)
            let audioBase64 = '';
            if (recording.audioBlob) {
                audioBase64 = await new Promise<string>((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result as string);
                    reader.readAsDataURL(recording.audioBlob!);
                });
            }

            const dataToSave = JSON.stringify({
                ...recording,
                audioBlob: undefined,
                audioBase64
            });

            // 2. Determine canvas size
            const bitsNeeded = (dataToSave.length + 12) * 8 + 32;
            const pixelsNeeded = Math.ceil(bitsNeeded / 3);
            const dimension = Math.ceil(Math.sqrt(pixelsNeeded));
            const width = Math.max(400, Math.ceil(dimension / 50) * 50);
            const height = width;

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d')!;
            canvas.width = width;
            canvas.height = height;

            // 3. Draw style
            switch (imageStyle) {
                case 'gradient': {
                    const grad = ctx.createLinearGradient(0, 0, width, height);
                    const h1 = Math.random() * 360;
                    const h2 = (h1 + 60) % 360;
                    grad.addColorStop(0, `hsl(${h1}, 70%, 60%)`);
                    grad.addColorStop(1, `hsl(${h2}, 70%, 60%)`);
                    ctx.fillStyle = grad;
                    ctx.fillRect(0, 0, width, height);
                    break;
                }
                case 'pixelated': {
                    const ps = 20;
                    for (let y = 0; y < height; y += ps) {
                        for (let x = 0; x < width; x += ps) {
                            ctx.fillStyle = `hsl(${Math.random() * 360}, 60%, 60%)`;
                            ctx.fillRect(x, y, ps, ps);
                        }
                    }
                    break;
                }
                case 'abstract': {
                    ctx.fillStyle = '#f8fafc';
                    ctx.fillRect(0, 0, width, height);
                    for (let i = 0; i < 20; i++) {
                        ctx.fillStyle = `hsla(${Math.random() * 360}, 70%, 60%, 0.5)`;
                        ctx.beginPath();
                        ctx.arc(Math.random() * width, Math.random() * height, Math.random() * 100 + 50, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    break;
                }
                case 'geometric': {
                    ctx.fillStyle = '#1e293b';
                    ctx.fillRect(0, 0, width, height);
                    for (let i = 0; i < 15; i++) {
                        ctx.fillStyle = `hsla(${Math.random() * 360}, 60%, 50%, 0.8)`;
                        ctx.beginPath();
                        const sides = 3 + Math.floor(Math.random() * 3);
                        const rx = Math.random() * width;
                        const ry = Math.random() * height;
                        const rad = 50 + Math.random() * 100;
                        for (let j = 0; j <= sides; j++) {
                            const ang = (j / sides) * Math.PI * 2;
                            const px = rx + Math.cos(ang) * rad;
                            const py = ry + Math.sin(ang) * rad;
                            if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                        }
                        ctx.fill();
                    }
                    break;
                }
                case 'noise': {
                    const id = ctx.createImageData(width, height);
                    for (let i = 0; i < id.data.length; i += 4) {
                        const v = 120 + Math.random() * 100;
                        id.data[i] = v; id.data[i + 1] = v; id.data[i + 2] = v; id.data[i + 3] = 255;
                    }
                    ctx.putImageData(id, 0, 0);
                    break;
                }
            }

            // 4. Add Title
            if (imageTitle) {
                ctx.save();
                const oh = Math.max(80, height * 0.15);
                const oy = (height - oh) / 2;
                const og = ctx.createLinearGradient(0, oy, 0, oy + oh);
                og.addColorStop(0, 'rgba(0,0,0,0)');
                og.addColorStop(0.5, 'rgba(0,0,0,0.6)');
                og.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = og;
                ctx.fillRect(0, oy, width, oh);

                const fs = Math.max(24, Math.min(48, width / 15));
                ctx.font = `bold ${fs}px sans-serif`;
                ctx.fillStyle = 'white';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.shadowColor = 'rgba(0,0,0,0.5)';
                ctx.shadowBlur = 10;
                ctx.fillText(imageTitle, width / 2, height / 2);
                ctx.restore();
            }

            // 5. Encode Data
            encodeDataInCanvas(canvas, dataToSave);

            canvas.toBlob(async (blob) => {
                if (blob) {
                    const file = new File([blob], `scrimba-${Date.now()}.png`, { type: 'image/png' });

                    if (previewUrl) URL.revokeObjectURL(previewUrl);
                    const newPreviewUrl = URL.createObjectURL(blob);
                    setPreviewUrl(newPreviewUrl);

                    if (isManualDownload) {
                        onSave(file);
                        const a = document.createElement('a');
                        a.href = newPreviewUrl;
                        a.download = file.name;
                        a.click();
                    }

                    if (shareToMastodon) {
                        try {
                            // 1. Get credentials from cookies
                            const getCookie = (name: string) => {
                                const value = `; ${document.cookie}`;
                                const parts = value.split(`; ${name}=`);
                                if (parts.length === 2) return parts.pop()?.split(';').shift();
                            };

                            const accessToken = getCookie('accessToken');
                            const instanceURL = getCookie('instanceURL');

                            if (!accessToken || !instanceURL) {
                                alert('Please sign in to Mastodon first.');
                                setIsGenerating(false);
                                return;
                            }

                            // 2. Upload to Mastodon
                            const formData = new FormData();
                            formData.append('file', file);
                            formData.append('description', `Scrimba tutorial: ${imageTitle || 'Untitled'}`);

                            const response = await fetch(`${instanceURL.replace(/\/$/, '')}/api/v2/media`, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${accessToken}`,
                                },
                                body: formData,
                            });

                            if (!response.ok) {
                                throw new Error('Failed to upload to Mastodon');
                            }

                            const mediaData = await response.json();
                            const mediaId = mediaData.id;

                            // 3. Redirect to next-mastodon compose page
                            const postTitle = imageTitle || 'New Scrimba Tutorial';
                            const postText = initialText
                                ? encodeURIComponent(`${initialText}\n\n#scrimba #tutorial`)
                                : encodeURIComponent(`${postTitle}\n\n#scrimba #tutorial`);
                            const baseUrl = window.location.hostname === 'localhost' ? 'http://localhost:9003' : 'https://mastodon.website';
                            window.location.href = `${baseUrl}/compose?media_ids=${mediaId}&text=${postText}`;
                        } catch (err) {
                            console.error('Sharing failed:', err);
                            alert('Failed to share on Mastodon. Please try again.');
                        }
                    }
                }
                setIsGenerating(false);
            }, 'image/png');

        } catch (err) {
            console.error('Failed to generate image:', err);
            setIsGenerating(false);
        }
    };

    // Auto-generate preview
    React.useEffect(() => {
        if (isVisible) {
            const timer = setTimeout(() => {
                generateImage(false, false);
            }, 300);
            return () => clearTimeout(timer);
        }
    }, [imageTitle, imageStyle, isVisible]);

    if (!isVisible) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-3xl w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden relative shadow-2xl animate-in zoom-in-95 duration-200">
                <div className="p-6 border-b shrink-0">
                    <h2 className="text-xl font-bold text-gray-900">Save Tutorial to Image</h2>
                    <p className="text-sm text-gray-500 mt-1">
                        This will create a PNG image containing your tutorial data.
                    </p>
                </div>

                <div className="flex-1 overflow-y-auto">
                    <div className="px-6 pt-6">
                        {previewUrl ? (
                            <div className="relative aspect-video w-full rounded-xl overflow-hidden border border-gray-200 shadow-inner bg-gray-100 flex items-center justify-center">
                                <img src={previewUrl} alt="Preview" className="max-w-full max-h-full object-contain" />
                                {isGenerating && (
                                    <div className="absolute inset-0 bg-white/40 backdrop-blur-[2px] flex items-center justify-center">
                                        <div className="px-3 py-1 bg-black/60 text-white text-xs rounded-full">Updating...</div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="aspect-video w-full rounded-xl border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400 text-sm">
                                {isGenerating ? 'Generating preview...' : 'No preview available'}
                            </div>
                        )}
                    </div>

                    <div className="p-6 space-y-5">
                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-2">Tutorial Title</label>
                            <input
                                type="text"
                                value={imageTitle}
                                onChange={(e) => setImageTitle(e.target.value)}
                                placeholder="e.g. How to use Flexbox"
                                className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:bg-white outline-none transition-all text-gray-900"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-2">Image Style</label>
                            <select
                                value={imageStyle}
                                onChange={(e) => setImageStyle(e.target.value as ImageStyle)}
                                className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:bg-white outline-none transition-all text-gray-900"
                            >
                                <option value="gradient">Smooth Gradient</option>
                                <option value="pixelated">Pixel Art</option>
                                <option value="abstract">Abstract Art</option>
                                <option value="geometric">Geometric Patterns</option>
                                <option value="noise">Noise Pattern</option>
                            </select>
                        </div>

                        <div className="bg-blue-50 p-4 rounded-xl border border-blue-100">
                            <p className="text-xs text-blue-700 leading-relaxed">
                                <strong>Tip:</strong> The tutorial data is hidden in the pixels. You can upload this image to Mastodon and others can play it!
                            </p>
                        </div>
                    </div>
                </div>

                <div className="p-6 bg-gray-50 border-t flex gap-3 shrink-0">
                    <button
                        onClick={onCancel}
                        className="flex-1 px-4 py-2.5 text-gray-700 font-medium hover:bg-gray-200 rounded-xl transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => generateImage(true, false)}
                        disabled={isGenerating}
                        className="flex-1 px-4 py-2.5 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-blue-200"
                    >
                        {isGenerating && !previewUrl ? 'Generating...' : 'Save Image'}
                    </button>
                    <button
                        onClick={() => generateImage(true, true)}
                        disabled={isGenerating}
                        className="flex-1 px-4 py-2.5 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-indigo-200"
                    >
                        {isGenerating && !previewUrl ? 'Generating...' : 'Share on Mastodon'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ScrimbaImageSaveModal;
