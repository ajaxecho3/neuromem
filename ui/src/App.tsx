import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "./components/ui/sidebar";
import { AppSidebar } from "./components/AppSidebar";
import { Routes, Route } from "react-router-dom";
import { AgentDashboard } from "./views/AgentDashboard";
import { CognitionLog } from "./views/CognitionLog";
import { ContextBuilder } from "./views/ContextBuilder";
import { GraphView } from "./views/GraphView";
import { MemoryBrowser } from "./views/MemoryBrowser";
import { MemoryDetail } from "./views/MemoryDetail";

function App() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2">
          <SidebarTrigger className="ml-1" />
          <div className="h-4 w-px bg-border/40" />
          <span className="text-sm text-muted-foreground font-ibm-mono">
            NeuroMem
          </span>
        </header>
        <main className="flex flex-1 flex-col gap-4 p-4 pt-0">
          <Routes>
            <Route path="/" element={<MemoryBrowser />} />
            <Route path="/graph" element={<GraphView />} />
            <Route path="/context" element={<ContextBuilder />} />
            <Route path="/dashboard" element={<AgentDashboard />} />
            <Route path="/cognition" element={<CognitionLog />} />
            <Route path="/memory/:id" element={<MemoryDetail />} />
          </Routes>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

export default App;
