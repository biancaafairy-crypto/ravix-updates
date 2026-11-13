import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary capturou erro de renderização:", error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-6 bg-[#090B0E] text-zinc-200 select-none">
          <div className="max-w-md w-full bg-[#10141D] border border-red-500/30 rounded-2xl p-6 shadow-2xl flex flex-col items-center text-center gap-4">
            <div className="h-12 w-12 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-400">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">
                {this.props.fallbackTitle || "Problema de Exibição Visual"}
              </h2>
              <p className="text-xs text-zinc-400 mt-1">
                Ocorreu uma falha inesperada na interface. Seus arquivos e o projeto foram preservados em segurança.
              </p>
              {this.state.error && (
                <div className="mt-3 p-2 bg-black/40 rounded-lg text-[10px] font-mono text-red-300 text-left overflow-auto max-h-24 border border-zinc-800">
                  {this.state.error.message || String(this.state.error)}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={this.handleReset}
              className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold flex items-center gap-2 shadow-lg shadow-purple-900/30 transition-all cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Recuperar Interface
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
