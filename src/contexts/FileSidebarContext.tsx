import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  readStoredFileSidebarCollapsed,
  writeStoredFileSidebarCollapsed,
} from "../utils/sidebarLayout";

interface FileSidebarContextValue {
  isCollapsed: boolean;
  showSidebar: () => void;
  hideSidebar: () => void;
  toggleSidebar: () => void;
}

const FileSidebarContext = createContext<FileSidebarContextValue | null>(null);

interface FileSidebarProviderProps {
  children: ReactNode;
}

export const FileSidebarProvider = memo(function FileSidebarProvider({
  children,
}: FileSidebarProviderProps) {
  const [isCollapsed, setIsCollapsed] = useState(readStoredFileSidebarCollapsed);

  const setCollapsed = useCallback((collapsed: boolean) => {
    setIsCollapsed((current) => {
      if (current === collapsed) {
        return current;
      }

      writeStoredFileSidebarCollapsed(collapsed);
      return collapsed;
    });
  }, []);

  const showSidebar = useCallback(() => setCollapsed(false), [setCollapsed]);
  const hideSidebar = useCallback(() => setCollapsed(true), [setCollapsed]);
  const toggleSidebar = useCallback(() => {
    setIsCollapsed((current) => {
      const next = !current;
      writeStoredFileSidebarCollapsed(next);
      return next;
    });
  }, []);

  const value = useMemo<FileSidebarContextValue>(
    () => ({
      isCollapsed,
      showSidebar,
      hideSidebar,
      toggleSidebar,
    }),
    [hideSidebar, isCollapsed, showSidebar, toggleSidebar],
  );

  return <FileSidebarContext.Provider value={value}>{children}</FileSidebarContext.Provider>;
});

export function useFileSidebar(): FileSidebarContextValue {
  const context = useContext(FileSidebarContext);

  if (!context) {
    throw new Error("useFileSidebar must be used inside FileSidebarProvider");
  }

  return context;
}
