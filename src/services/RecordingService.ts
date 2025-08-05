import { store } from '../store';
import { startRecording, stopRecording, type Recording } from '../store/slices/recordingSlice';
import { useAudioRecording } from '../hooks/useAudioRecording';

class RecordingService {
  private audioRecordingHook: ReturnType<typeof useAudioRecording> | null = null;
  
  async startSession(): Promise<boolean> {
    try {
      // Start audio recording first
      if (this.audioRecordingHook) {
        await this.audioRecordingHook.startRecording();
      }
      
      // Start editor event recording
      store.dispatch(startRecording());
      
      return true;
    } catch (error) {
      console.error('Failed to start recording session:', error);
      return false;
    }
  }
  
  async stopSession(): Promise<Recording | null> {
    try {
      // Stop audio recording
      let audioBlob: Blob | null = null;
      if (this.audioRecordingHook) {
        audioBlob = await this.audioRecordingHook.stopRecording();
      }
      
      // Stop editor event recording and create recording
      store.dispatch(stopRecording({ audioBlob: audioBlob || undefined }));
      
      // Get the newly created recording
      const state = store.getState();
      const recordings = state.recording.recordings;
      return recordings[recordings.length - 1] || null;
    } catch (error) {
      console.error('Failed to stop recording session:', error);
      return null;
    }
  }
  
  setAudioRecordingHook(hook: ReturnType<typeof useAudioRecording>) {
    this.audioRecordingHook = hook;
  }
  
  isRecording(): boolean {
    return store.getState().recording.isRecording;
  }
}

export const recordingService = new RecordingService();