import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { Recording } from '../core/src';
import { encodeDataInCanvas, injectPngMetadata } from '../core/src/utils/steganography';
import pako from 'pako';
import {
    X,
    Download,
    Share2,
    Palette,
    Type,
    ChevronRight,
    Check,
    Waves,
    Grid3X3,
    Wind,
    Shapes,
    Sparkles,
    Copy,
    ExternalLink
} from 'lucide-react';
import MastodonIcon from './icon/Mastodon';
import { MAGIC_PREFIX } from '../core/src/utils/steganography';



interface NextEditorImageSaveModalProps {
    recording: Recording;
    isVisible: boolean;
    onSave: (file: File) => void;
    onCancel: () => void;
    initialText?: string;
}

type ImageStyle = 'gradient' | 'pixelated' | 'abstract' | 'noise' | 'geometric';

interface StyleOption {
    id: ImageStyle;
    label: string;
    icon: React.ReactNode;
    description: string;
}

const STYLE_OPTIONS: StyleOption[] = [
    {
        id: 'gradient',
        label: 'Gradient',
        icon: <Waves className="w-4 h-4" />,
        description: 'Smooth colors',
    },
    {
        id: 'pixelated',
        label: 'Pixel Art',
        icon: <Grid3X3 className="w-4 h-4" />,
        description: 'Retro style',
    },
    {
        id: 'abstract',
        label: 'Abstract',
        icon: <Sparkles className="w-4 h-4" />,
        description: 'Artistic blobs',
    },
    {
        id: 'geometric',
        label: 'Geometric',
        icon: <Shapes className="w-4 h-4" />,
        description: 'Clean shapes',
    },
    {
        id: 'noise',
        label: 'Noise',
        icon: <Wind className="w-4 h-4" />,
        description: 'Textured look',
    },
];

const NextEditorImageSaveModal: React.FC<NextEditorImageSaveModalProps> = ({
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
    const previewUrlRef = useRef<string | null>(null);
    const [composeLink, setComposeLink] = useState<string | null>(null);
    const [linkCopied, setLinkCopied] = useState(false);

    // Cache the encoded canvas (without title overlay) for quick title updates
    const encodedCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const canvasDimensionsRef = useRef<{ width: number; height: number } | null>(null);
    const imageTitleRef = useRef(imageTitle);
    const lastEncodedDataRef = useRef<string | null>(null);

    // Generate the base image with encoding (expensive operation)
    const generateEncodedImage = useCallback(async (title: string) => {
        if (!isVisible) return null;

        try {
            // 1. Prepare data (Recording JSON)
            let audioBase64 = '';
            if (recording.audioBlob instanceof Blob) {
                audioBase64 = await new Promise<string>((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result as string);
                    reader.readAsDataURL(recording.audioBlob as Blob);
                });
            }

            const dataToSaveRaw = JSON.stringify({
                ...recording,
                audioBlob: undefined,
                audioBase64
            });
            lastEncodedDataRef.current = dataToSaveRaw;

            // 2. Determine canvas size (with compression estimation)
            // encodeDataInCanvas will deflate + base64 the data, so we estimate that size.
            const compressed = pako.deflate(dataToSaveRaw);
            const estimatedEncodedLength = MAGIC_PREFIX.length + Math.ceil(compressed.length * 4 / 3);

            const bitsNeeded = (estimatedEncodedLength) * 8 + 32;
            const pixelsNeeded = Math.ceil(bitsNeeded / 3);
            const dimension = Math.ceil(Math.sqrt(pixelsNeeded));

            // Add extra 10% padding to dimensions to ensure we have enough pixels even with UI elements
            // and to avoid browser boundary issues.
            const width = Math.max(800, Math.ceil((dimension * 1.1) / 50) * 50);
            const height = width;

            const canvas = document.createElement('canvas');
            // Use srgb color space to ensure deterministic pixel values across different browsers
            const ctx = canvas.getContext('2d', {
                colorSpace: 'srgb',
                willReadFrequently: true
            })!;
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

            // 4. Draw title overlay BEFORE encoding data
            // This ensures the steganography data is encoded into the pixels AFTER they are drawn
            if (title) {
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
                ctx.fillText(title, width / 2, height / 2);
                ctx.restore();
            }

            // 5. Encode Data
            const encodedData = await encodeDataInCanvas(canvas, dataToSaveRaw);
            lastEncodedDataRef.current = encodedData;

            // Cache the encoded canvas
            encodedCanvasRef.current = canvas;
            canvasDimensionsRef.current = { width, height };

            return canvas;
        } catch (err) {
            console.error('Failed to generate encoded image:', err);
            return null;
        }
    }, [imageStyle, isVisible, recording]);

    // Generate preview from current title and style
    const updatePreview = useCallback(async () => {
        setIsGenerating(true);
        const finalCanvas = await generateEncodedImage(imageTitleRef.current);
        if (!finalCanvas) {
            setIsGenerating(false);
            return;
        }

        finalCanvas.toBlob((blob) => {
            if (blob) {
                if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
                const newPreviewUrl = URL.createObjectURL(blob);
                previewUrlRef.current = newPreviewUrl;
                setPreviewUrl(newPreviewUrl);
            }
            setIsGenerating(false);
        }, 'image/png');
    }, [generateEncodedImage]);

    // Generate full image for download/share (re-encodes with title)
    const generateFinalImage = useCallback(async (isManualDownload: boolean = false, shareToMastodon: boolean = false) => {
        if (!isVisible) return;
        setIsGenerating(true);

        try {
            // Always generate a fresh encoded image with style + title
            const finalCanvas = await generateEncodedImage(imageTitleRef.current);
            if (!finalCanvas) {
                setIsGenerating(false);
                return;
            }

            finalCanvas.toBlob(async (blob) => {
                if (blob) {
                    // Inject metadata chunk for 100% reliable import on Mac/Retina
                    let finalBlob = blob;
                    if (lastEncodedDataRef.current) {
                        try {
                            const buffer = await blob.arrayBuffer();
                            const injected = injectPngMetadata(new Uint8Array(buffer), 'NEXT_EDITOR_v2_DATA', lastEncodedDataRef.current);
                            finalBlob = new Blob([injected as BlobPart], { type: 'image/png' });
                        } catch (err) {
                            console.error('Failed to inject PNG metadata:', err);
                        }
                    }

                    const file = new File([finalBlob], `next-editor-${Date.now()}.png`, { type: 'image/png' });

                    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
                    const newPreviewUrl = URL.createObjectURL(finalBlob);
                    previewUrlRef.current = newPreviewUrl;
                    setPreviewUrl(newPreviewUrl);

                    if (isManualDownload) {
                        onSave(file);
                        const a = document.createElement('a');
                        a.href = newPreviewUrl;
                        a.download = file.name;
                        a.click();
                    }

                    if (shareToMastodon) {
                        const baseUrl = window.location.hostname === 'localhost' ? 'http://localhost:9003' : 'https://mastodon.website';
                        const newWindow = window.open('about:blank', '_blank');

                        try {
                            const getCookie = (name: string) => {
                                const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
                                if (!match) return undefined;
                                let value = match[2];
                                try {
                                    value = decodeURIComponent(value).replace(/^"(.*)"$/, '$1');
                                    if (value.includes('%')) {
                                        value = decodeURIComponent(value);
                                    }
                                    return value;
                                } catch {
                                    return value;
                                }
                            };

                            const accessToken = getCookie('accessToken');
                            const instanceURL = getCookie('instanceURL');

                            if (!accessToken || !instanceURL) {
                                newWindow?.close();
                                alert('Please sign in to Mastodon first.');
                                setIsGenerating(false);
                                return;
                            }

                            if (!instanceURL.startsWith('http')) {
                                newWindow?.close();
                                console.error('Invalid instance URL from cookie:', instanceURL);
                                alert(`Invalid Mastodon instance URL: ${instanceURL}`);
                                setIsGenerating(false);
                                return;
                            }

                            const formData = new FormData();
                            formData.append('file', file);
                            formData.append('description', `tutorial: ${imageTitleRef.current || 'Untitled'}`);

                            const uploadUrl = `${instanceURL.replace(/\/$/, '')}/api/v2/media`;
                            const response = await fetch(uploadUrl, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${accessToken}`,
                                },
                                body: formData,
                            });

                            if (!response.ok) {
                                newWindow?.close();
                                throw new Error('Failed to upload to Mastodon');
                            }

                            const mediaData = await response.json();
                            const mediaId = mediaData.id;

                            const postTitle = imageTitleRef.current || 'New Tutorial';
                            const postText = initialText
                                ? encodeURIComponent(`${initialText}\n\n#nexteditor #tutorial`)
                                : encodeURIComponent(`${postTitle}\n\n#nexteditor #tutorial`);

                            const finalComposeUrl = `${baseUrl}/compose?media_ids=${mediaId}&text=${postText}`;
                            setComposeLink(finalComposeUrl);

                            if (newWindow) {
                                newWindow.location.href = finalComposeUrl;
                            }

                        } catch (err) {
                            newWindow?.close();
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
    }, [generateEncodedImage, initialText, isVisible, onSave]);

    // Generate encoded image when modal opens or style changes
    useEffect(() => {
        if (isVisible) {
            const timer = setTimeout(async () => {
                await updatePreview();
            }, 300);
            return () => clearTimeout(timer);
        }
    }, [isVisible, imageStyle, updatePreview]);

    if (!isVisible) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-gray-950/80 backdrop-blur-md animate-in fade-in duration-300">
            <div className="bg-[#1e2532] border border-gray-700/50 rounded-[32px] w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden relative shadow-[0_32px_64px_-16px_rgba(0,0,0,0.6)] animate-in zoom-in-95 slide-in-from-bottom-8 duration-500">
                {/* Close Button */}
                <button
                    onClick={onCancel}
                    className="absolute top-6 right-6 p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-full transition-all z-10"
                >
                    <X className="w-5 h-5" />
                </button>

                <div className="p-8 border-b border-gray-700/50 shrink-0">
                    <h2 className="text-2xl font-bold text-white flex items-center gap-3">
                        <div className="p-2 bg-indigo-500/20 rounded-xl">
                            <Share2 className="w-6 h-6 text-indigo-400" />
                        </div>
                        Share Tutorial
                    </h2>
                    <p className="text-gray-400 mt-2">
                        Generate a beautiful image containing your tutorial data to share with the world.
                    </p>
                </div>

                <div className="flex-1 overflow-y-auto">
                    <div className="p-8 grid grid-cols-1 md:grid-cols-2 gap-8">
                        {/* Left Column: Preview */}
                        <div className="space-y-4">
                            <span className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                                <Sparkles className="w-3 h-3" />
                                Preview
                            </span>
                            <div className="relative aspect-square w-full rounded-2xl overflow-hidden border border-gray-700 bg-gray-900 group shadow-2xl">
                                {previewUrl ? (
                                    <>
                                        <img src={previewUrl} alt="Preview" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" />
                                        {isGenerating && (
                                            <div className="absolute inset-0 bg-gray-900/60 backdrop-blur-[2px] flex flex-col items-center justify-center gap-3 transition-opacity duration-300">
                                                <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                                                <span className="text-xs text-indigo-300 font-medium">Updating...</span>
                                            </div>
                                        )}
                                        {/* Frame Overlay */}
                                        <div className="absolute inset-0 border-[12px] border-white/5 pointer-events-none" />
                                    </>
                                ) : (
                                    <div className="w-full h-full flex flex-col items-center justify-center gap-4 text-gray-500 bg-gray-800/50">
                                        <div className="w-12 h-12 border-2 border-dashed border-gray-600 rounded-full flex items-center justify-center">
                                            <Share2 className="w-6 h-6" />
                                        </div>
                                        <span className="text-sm font-medium">Generating preview...</span>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Right Column: Controls */}
                        <div className="space-y-6">
                            {/* Title Input */}
                            <div className="space-y-3">
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                                    <Type className="w-3 h-3" />
                                    Tutorial Title
                                </label>
                                <div className="relative">
                                    <input
                                        type="text"
                                        value={imageTitle}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            setImageTitle(val);
                                            imageTitleRef.current = val;
                                        }}
                                        placeholder="e.g. Mastering Flexbox"
                                        className="w-full px-5 py-3.5 bg-gray-800/50 border border-gray-700/50 rounded-2xl focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 focus:bg-gray-800 outline-none transition-all text-white placeholder:text-gray-600 pr-32"
                                    />
                                    <button
                                        onClick={updatePreview}
                                        disabled={isGenerating || !encodedCanvasRef.current}
                                        className="absolute right-2 top-2 bottom-2 px-4 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 disabled:bg-gray-700 text-white text-xs font-bold rounded-xl transition-all flex items-center gap-2"
                                    >
                                        <Sparkles className="w-3 h-3" />
                                        Update
                                    </button>
                                </div>
                            </div>

                            {/* Style Grid */}
                            <div className="space-y-3">
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                                    <Palette className="w-3 h-3" />
                                    Background Style
                                </label>
                                <div className="grid grid-cols-2 gap-3">
                                    {STYLE_OPTIONS.map((style) => (
                                        <button
                                            key={style.id}
                                            onClick={() => setImageStyle(style.id)}
                                            className={`
                                                relative flex flex-col items-start p-3.5 rounded-2xl border transition-all text-left group
                                                ${imageStyle === style.id
                                                    ? 'bg-indigo-500/10 border-indigo-500 shadow-[0_0_20px_rgba(99,102,241,0.1)]'
                                                    : 'bg-gray-800/30 border-gray-700/50 hover:border-gray-600 hover:bg-gray-800/50'}
                                            `}
                                        >
                                            <div className={`
                                                p-2 rounded-lg mb-2 transition-colors
                                                ${imageStyle === style.id ? 'bg-indigo-500 text-white' : 'bg-gray-700 text-gray-400 group-hover:text-gray-300'}
                                            `}>
                                                {style.icon}
                                            </div>
                                            <span className={`text-sm font-semibold ${imageStyle === style.id ? 'text-white' : 'text-gray-300'}`}>
                                                {style.label}
                                            </span>
                                            <span className="text-[10px] text-gray-500 mt-0.5 leading-tight">
                                                {style.description}
                                            </span>
                                            {imageStyle === style.id && (
                                                <div className="absolute top-3 right-3">
                                                    <Check className="w-4 h-4 text-indigo-400" />
                                                </div>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="px-8 pb-8">
                        <div className="bg-indigo-500/10 border border-indigo-500/20 p-4 rounded-2xl flex gap-4 items-start">
                            <div className="mt-1">
                                <Sparkles className="w-4 h-4 text-indigo-400" />
                            </div>
                            <p className="text-xs text-indigo-300 leading-relaxed">
                                <strong>Steganography magic:</strong> Your tutorial data is invisible to the human eye but embedded in the image pixels. Upload to Mastodon and others can play it instantly!
                            </p>
                        </div>
                    </div>
                </div>

                <div className="p-8 bg-gray-900/50 border-t border-gray-700/50 flex flex-col gap-4 shrink-0">
                    {/* Show compose link after successful upload */}
                    {composeLink && (
                        <div className="flex flex-col gap-3 p-4 bg-green-500/10 border border-green-500/30 rounded-2xl">
                            <div className="flex items-center gap-2 text-green-400 text-sm font-medium">
                                <Check className="w-4 h-4" />
                                Upload complete! If the tab didn&apos;t open, use the buttons below:
                            </div>
                            <div className="flex gap-2">
                                <a
                                    href={composeLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white font-medium rounded-xl hover:bg-green-500 transition-colors"
                                >
                                    <ExternalLink className="w-4 h-4" />
                                    Open Link
                                </a>
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(composeLink);
                                        setLinkCopied(true);
                                        setTimeout(() => setLinkCopied(false), 2000);
                                    }}
                                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-700 text-white font-medium rounded-xl hover:bg-gray-600 transition-colors"
                                >
                                    <Copy className="w-4 h-4" />
                                    {linkCopied ? 'Copied!' : 'Copy Link'}
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="flex flex-col sm:flex-row gap-4">
                        <button
                            onClick={() => generateFinalImage(true, false)}
                            disabled={isGenerating}
                            className="flex-1 flex items-center justify-center gap-2 px-6 py-4 bg-gray-800 text-gray-200 font-bold rounded-2xl hover:bg-gray-700 active:scale-95 disabled:opacity-50 disabled:active:scale-100 transition-all border border-gray-700 shadow-xl"
                        >
                            <Download className="w-5 h-5" />
                            Download Image
                        </button>
                        <button
                            onClick={() => {
                                setComposeLink(null);
                                generateFinalImage(false, true);
                            }}
                            disabled={isGenerating}
                            className="flex-[1.5] flex items-center justify-center gap-3 px-6 py-4 bg-indigo-600 text-white font-bold rounded-2xl hover:bg-indigo-500 active:scale-95 disabled:opacity-50 disabled:active:scale-100 transition-all shadow-[0_8px_32px_rgba(79,70,229,0.3)] group"
                        >
                            <div className="transition-transform group-hover:rotate-12">
                                <MastodonIcon />
                            </div>
                            Share on Mastodon
                            <ChevronRight className="w-5 h-5 opacity-50 group-hover:translate-x-1 transition-transform" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default NextEditorImageSaveModal;
