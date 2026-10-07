import axios from "axios";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../apiClient";

export interface StudioCapabilities {
  burmeseVoxCpm2: boolean;
  /** The server can hold users' own AthanLab keys (its encryption secret is configured). */
  athanlab: boolean;
}

const NO_STUDIO_CAPABILITIES: StudioCapabilities = {
  burmeseVoxCpm2: false,
  athanlab: false,
};

async function fetchStudioCapabilities(): Promise<StudioCapabilities> {
  try {
    const response = await apiClient.get<Partial<StudioCapabilities>>("/studio/capabilities");
    // A capability the server does not report stays off.
    return { ...NO_STUDIO_CAPABILITIES, ...response.data };
  } catch (error) {
    // The session can disappear between /auth/me and this request. Treat that
    // as signed out; other failures remain observable through Query state.
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      return NO_STUDIO_CAPABILITIES;
    }
    throw error;
  }
}

export function useStudioCapabilities(userId: string | null) {
  const query = useQuery({
    queryKey: ["studio", "capabilities", userId],
    queryFn: fetchStudioCapabilities,
    enabled: userId !== null,
    staleTime: 60_000,
  });

  return {
    capabilities: userId === null ? NO_STUDIO_CAPABILITIES : (query.data ?? NO_STUDIO_CAPABILITIES),
    isLoading: userId !== null && query.isPending,
  };
}
