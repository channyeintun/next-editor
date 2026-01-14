import React, { useState, useRef } from 'react';
import type { Recording } from '../use-scrimba/src';
import { encodeDataInVideo } from '../use-scrimba/src/utils/video-steganography';
import {
    X,
    Download,
    Share2,
    Palette,
    Type,
    ChevronRight,
    Check,
    Waves,
    Wind,
    Shapes,
    Sparkles,
    Zap,
    Circle
} from 'lucide-react';
import MastodonIcon from './icon/Mastodon';

interface ScrimbaVideoSaveModalProps {
    recording: Recording;
    isVisible: boolean;
    onSave: (file: File) => void;
    onCancel: () => void;
    initialText?: string;
}

type VideoStyle = 'gradient' | 'particles' | 'waves' | 'geometric' | 'pulse';

interface StyleOption {
    id: VideoStyle;
    label: string;
    icon: React.ReactNode;
    description: string;
}

const STYLE_OPTIONS: StyleOption[] = [
    {
        id: 'gradient',
        label: 'Gradient',
        icon: <Waves className="w-4 h-4" />,
        description: 'Animated colors',
    },
    {
        id: 'particles',
        label: 'Particles',
        icon: <Sparkles className="w-4 h-4" />,
        description: 'Moving dots',
    },
    {
        id: 'waves',
        label: 'Waves',
        icon: <Wind className="w-4 h-4" />,
        description: 'Flowing waves',
    },
    {
        id: 'geometric',
        label: 'Geometric',
        icon: <Shapes className="w-4 h-4" />,
        description: 'Rotating shapes',
    },
    {
        id: 'pulse',
        label: 'Pulse',
        icon: <Circle className="w-4 h-4" />,
        description: 'Breathing effect',
    },
];

const ScrimbaVideoSaveModal: React.FC<ScrimbaVideoSaveModalProps> = ({
    recording,
    isVisible,
    onSave,
    onCancel,
    initialText
}) => {
    const [videoTitle, setVideoTitle] = useState('');
    const [videoStyle, setVideoStyle] = useState<VideoStyle>('gradient');
    const [isGenerating, setIsGenerating] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [stats, setStats] = useState<{ fileSize: string; duration: string } | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);

    const generateVideo = async (isManualDownload: boolean = false, shareToMastodon: boolean = false) => {
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

            // 2. Generate video with encoded data
            const { videoBlob, duration } = await encodeDataInVideo(
                dataToSave,
                videoStyle,
                videoTitle
            );

            const file = new File([videoBlob], `scrimba-${Date.now()}.webm`, { type: 'video/webm' });

            // 3. Update preview
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            const newPreviewUrl = URL.createObjectURL(videoBlob);
            setPreviewUrl(newPreviewUrl);

            setStats({
                fileSize: (videoBlob.size / (1024 * 1024)).toFixed(2),
                duration: duration.toFixed(1)
            });

            // 4. Handle download
            if (isManualDownload) {
                onSave(file);
                const a = document.createElement('a');
                a.href = newPreviewUrl;
                a.download = file.name;
                a.click();
            }

            // 5. Handle Mastodon share
            if (shareToMastodon) {
                try {
                    const getCookie = (name: string) => {
                        const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
                        if (!match) return undefined;

                        let value = match[2];
                        try {
                            value = decodeURIComponent(value).replace(/^\"(.*)\"$/, '$1');
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
                        alert('Please sign in to Mastodon first.');
                        setIsGenerating(false);
                        return;
                    }

                    if (!instanceURL.startsWith('http')) {
                        console.error('Invalid instance URL from cookie:', instanceURL);
                        alert(`Invalid Mastodon instance URL: ${instanceURL}`);
                        setIsGenerating(false);
                        return;
                    }

                    // Upload to Mastodon
                    const formData = new FormData();
                    formData.append('file', file);
                    formData.append('description', `Scrimba tutorial: ${videoTitle || 'Untitled'}`);

                    const uploadUrl = `${instanceURL.replace(/\/$/, '')}/api/v2/media`;
                    const response = await fetch(uploadUrl, {
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

                    // Redirect to compose page
                    const postTitle = videoTitle || 'New Scrimba Tutorial';
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

            setIsGenerating(false);
        } catch (err) {
            console.error('Failed to generate video:', err);
            alert('Failed to generate video. Please try again.');
            setIsGenerating(false);
        }
    };

    // Auto-generate preview
    React.useEffect(() => {
        if (isVisible) {
            const timer = setTimeout(() => {
                generateVideo(false, false);
            }, 300);
            return () => clearTimeout(timer);
        }
    }, [videoTitle, videoStyle, isVisible]);

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
                        Share Tutorial (Video)
                    </h2>
                    <p className="text-gray-400 mt-2">
                        Generate an animated video containing your tutorial data - up to 99MB for Mastodon!
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
                            <div className="relative aspect-video w-full rounded-2xl overflow-hidden border border-gray-700 bg-gray-900 group shadow-2xl">
                                {previewUrl ? (
                                    <>
                                        <video
                                            ref={videoRef}
                                            src={previewUrl}
                                            loop
                                            autoPlay
                                            muted
                                            playsInline
                                            className="w-full h-full object-cover"
                                        />
                                        {isGenerating && (
                                            <div className="absolute inset-0 bg-gray-900/60 backdrop-blur-[2px] flex flex-col items-center justify-center gap-3 transition-opacity duration-300">
                                                <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                                                <span className="text-xs text-indigo-300 font-medium">Generating...</span>
                                            </div>
                                        )}
                                        {stats && !isGenerating && (
                                            <div className="absolute bottom-3 left-3 right-3 flex gap-2">
                                                <div className="px-3 py-1.5 bg-black/60 backdrop-blur-sm rounded-lg text-[10px] text-white font-medium">
                                                    {stats.duration}s
                                                </div>
                                                <div className="px-3 py-1.5 bg-black/60 backdrop-blur-sm rounded-lg text-[10px] text-white font-medium">
                                                    {stats.fileSize} MB
                                                </div>
                                            </div>
                                        )}
                                        <div className="absolute inset-0 border-[12px] border-white/5 pointer-events-none" />
                                    </>
                                ) : (
                                    <div className="w-full h-full flex flex-col items-center justify-center gap-4 text-gray-500 bg-gray-800/50">
                                        <div className="w-12 h-12 border-2 border-dashed border-gray-600 rounded-full flex items-center justify-center">
                                            <Zap className="w-6 h-6" />
                                        </div>
                                        <span className="text-sm font-medium">Generating video...</span>
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
                                <input
                                    type="text"
                                    value={videoTitle}
                                    onChange={(e) => setVideoTitle(e.target.value)}
                                    placeholder="e.g. Mastering Flexbox"
                                    className="w-full px-5 py-3.5 bg-gray-800/50 border border-gray-700/50 rounded-2xl focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 focus:bg-gray-800 outline-none transition-all text-white placeholder:text-gray-600"
                                />
                            </div>

                            {/* Style Grid */}
                            <div className="space-y-3">
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                                    <Palette className="w-3 h-3" />
                                    Animation Style
                                </label>
                                <div className="grid grid-cols-2 gap-3">
                                    {STYLE_OPTIONS.map((style) => (
                                        <button
                                            key={style.id}
                                            onClick={() => setVideoStyle(style.id)}
                                            className={`
                                                relative flex flex-col items-start p-3.5 rounded-2xl border transition-all text-left group
                                                ${videoStyle === style.id
                                                    ? 'bg-indigo-500/10 border-indigo-500 shadow-[0_0_20px_rgba(99,102,241,0.1)]'
                                                    : 'bg-gray-800/30 border-gray-700/50 hover:border-gray-600 hover:bg-gray-800/50'}
                                            `}
                                        >
                                            <div className={`
                                                p-2 rounded-lg mb-2 transition-colors
                                                ${videoStyle === style.id ? 'bg-indigo-500 text-white' : 'bg-gray-700 text-gray-400 group-hover:text-gray-300'}
                                            `}>
                                                {style.icon}
                                            </div>
                                            <span className={`text-sm font-semibold ${videoStyle === style.id ? 'text-white' : 'text-gray-300'}`}>
                                                {style.label}
                                            </span>
                                            <span className="text-[10px] text-gray-500 mt-0.5 leading-tight">
                                                {style.description}
                                            </span>
                                            {videoStyle === style.id && (
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
                            <div className="space-y-1">
                                <p className="text-xs text-indigo-300 leading-relaxed">
                                    <strong>Video steganography:</strong> Your tutorial data is encoded across video frames. Perfect for Mastodon's 99MB video limit!
                                </p>
                                <p className="text-[10px] text-indigo-400/60">
                                    640×480 @ 30fps • WebM format • Auto-sized for your data
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="p-8 bg-gray-900/50 border-t border-gray-700/50 flex flex-col sm:flex-row gap-4 shrink-0">
                    <button
                        onClick={() => generateVideo(true, false)}
                        disabled={isGenerating}
                        className="flex-1 flex items-center justify-center gap-2 px-6 py-4 bg-gray-800 text-gray-200 font-bold rounded-2xl hover:bg-gray-700 active:scale-95 disabled:opacity-50 disabled:active:scale-100 transition-all border border-gray-700 shadow-xl"
                    >
                        <Download className="w-5 h-5" />
                        Download Video
                    </button>
                    <button
                        onClick={() => generateVideo(false, true)}
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
    );
};

export default ScrimbaVideoSaveModal;
