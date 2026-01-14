import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useUrlLoader } from './useUrlLoader';

export const useUrlQuery = () => {
  const { fetchNextEditorFile, isLoading } = useUrlLoader();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const url = searchParams.get('url');

    if (url) {
      // Decode URL in case it was URL encoded
      const decodedUrl = decodeURIComponent(url);
      
      // Convert relative URLs to absolute URLs for same origin
      let fullUrl = decodedUrl;
      if (!decodedUrl.startsWith('http://') && !decodedUrl.startsWith('https://')) {
        // It's a relative URL, make it absolute with current origin
        const origin = window.location.origin;
        fullUrl = decodedUrl.startsWith('/') ? `${origin}${decodedUrl}` : `${origin}/${decodedUrl}`;
      }
      
      fetchNextEditorFile(fullUrl).catch(error => {
        console.error('Failed to load from URL query:', error);
      });
    }
  }, [searchParams]); // Only react to changes in searchParams

  return { isLoading };
};