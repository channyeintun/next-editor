/**
 * Calculates exact duration from audio blob using FileReader and AudioContext
 * This approach provides more accurate duration than HTML audio elements
 */
export async function calculateDurationFromFileReader(audioBlob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = function(e) {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        if (!arrayBuffer) {
          reject(new Error('Failed to read audio blob'));
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        
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