import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useScrimbaUrlLoader } from './useScrimbaUrlLoader';

export const useUrlQuery = () => {
  const { fetchScrimbaFile, isLoading } = useScrimbaUrlLoader();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const scrimUrl = searchParams.get('scrimUrl');

    if (scrimUrl) {
      // Decode URL in case it was URL encoded
      const decodedUrl = decodeURIComponent(scrimUrl);
      
      // Convert relative URLs to absolute URLs for same origin
      let fullUrl = decodedUrl;
      if (!decodedUrl.startsWith('http://') && !decodedUrl.startsWith('https://')) {
        // It's a relative URL, make it absolute with current origin
        const origin = window.location.origin;
        fullUrl = decodedUrl.startsWith('/') ? `${origin}${decodedUrl}` : `${origin}/${decodedUrl}`;
      }
      
      fetchScrimbaFile(fullUrl).catch(error => {
        console.error('Failed to load scrim from URL query:', error);
      });
    }
  }, [searchParams]); // Only react to changes in searchParams

  return { isLoading };
};