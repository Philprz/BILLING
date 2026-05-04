/**
 * AccountSearch — combobox SAP B1
 *
 * Règles de validation :
 * - onChange(acctCode) n'est émis QUE sur sélection explicite dans la liste.
 * - La frappe libre déclenche la recherche mais ne propage rien.
 * - Au blur sans sélection, le champ revient à l'affichage du dernier compte validé
 *   (ou vide si aucun).
 * - Aucune saisie libre ne peut être sauvegardée.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { X, AlertCircle, RefreshCw } from 'lucide-react';
import { apiSearchSapAccounts, type SapAccount } from '../../api/sap.api';

export interface AccountSearchProps {
  /** acctCode actuellement enregistré (vide = aucun). */
  value: string;
  onChange: (code: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /**
   * Quand value est vide, lance une recherche initiale à partir des mots-clés
   * de la description de ligne pour proposer un compte probable.
   */
  initialQuery?: string;
  /**
   * Si fourni, affiche un bouton "Synchroniser" dans l'état vide.
   * Après sync, relance automatiquement la dernière recherche.
   */
  onSyncRequest?: () => Promise<unknown>;
}

const STOP_WORDS = new Set([
  'les',
  'des',
  'une',
  'par',
  'sur',
  'sous',
  'avec',
  'pour',
  'dans',
  'sans',
  'que',
  'qui',
  'aux',
]);

function extractKeywords(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 3)
    .join(' ');
}

function accountLabel(a: SapAccount): string {
  return `${a.acctCode} — ${a.acctName}`;
}

type SearchState = 'idle' | 'loading' | 'ok' | 'empty' | 'error';

export function AccountSearch({
  value,
  onChange,
  placeholder,
  disabled,
  className,
  initialQuery,
  onSyncRequest,
}: AccountSearchProps) {
  const [selectedAccount, setSelectedAccount] = useState<SapAccount | null>(null);
  const [inputText, setInputText] = useState('');
  const [results, setResults] = useState<SapAccount[]>([]);
  const [open, setOpen] = useState(false);
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const lastQueryRef = useRef('');
  const syncingRef = useRef(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusSnapshot = useRef<{ text: string; account: SapAccount | null }>({
    text: '',
    account: null,
  });

  // ── Résolution initiale du nom quand value arrive avec un code ────────────
  useEffect(() => {
    if (!value) {
      setInputText('');
      setSelectedAccount(null);
      return;
    }
    if (selectedAccount?.acctCode === value) return;

    apiSearchSapAccounts(value)
      .then((accounts) => {
        const match = accounts.find((a) => a.acctCode === value);
        if (match) {
          setSelectedAccount(match);
          setInputText(accountLabel(match));
        } else {
          setInputText(value);
          setSelectedAccount(null);
        }
      })
      .catch(() => {
        setInputText(value);
        setSelectedAccount(null);
      });
  }, [value]);

  // ── Recherche auto au montage si champ vide et initialQuery fourni ────────
  useEffect(() => {
    if (!value && initialQuery) {
      const q = extractKeywords(initialQuery);
      if (q.length >= 1) {
        setSearchState('loading');
        apiSearchSapAccounts(q)
          .then((accounts) => {
            setResults(accounts);
            setSearchState(accounts.length > 0 ? 'ok' : 'empty');
            setOpen(accounts.length > 0);
          })
          .catch(() => {
            setResults([]);
            setSearchState('error');
          });
      }
    }
  }, []);

  // ── Recherche debounced pendant la frappe ─────────────────────────────────
  const doSearch = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 1) {
      setResults([]);
      setOpen(false);
      setSearchState('idle');
      return;
    }
    lastQueryRef.current = q;
    debounceRef.current = setTimeout(async () => {
      setSearchState('loading');
      try {
        const accounts = await apiSearchSapAccounts(q);
        setResults(accounts);
        setSearchState(accounts.length > 0 ? 'ok' : 'empty');
        setOpen(true);
        setActiveIndex(-1);
      } catch {
        setResults([]);
        setSearchState('error');
        setOpen(true);
      }
    }, 250);
  }, []);

  const handleSync = useCallback(async () => {
    if (!onSyncRequest) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncError(null);
    setOpen(true);
    try {
      await (onSyncRequest() as Promise<unknown>);
      const q = lastQueryRef.current;
      if (q.trim().length >= 1) {
        setSearchState('loading');
        const accounts = await apiSearchSapAccounts(q);
        setResults(accounts);
        setSearchState(accounts.length > 0 ? 'ok' : 'empty');
        setOpen(true);
        setActiveIndex(-1);
      }
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Erreur de synchronisation SAP');
      setOpen(true);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [onSyncRequest]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleFocus() {
    focusSnapshot.current = { text: inputText, account: selectedAccount };
    if (results.length > 0) setOpen(true);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setInputText(q);
    setSelectedAccount(null);
    doSearch(q);
  }

  function handleBlur() {
    setTimeout(() => {
      if (syncingRef.current) return; // ne pas fermer pendant une sync en cours
      if (!selectedAccount) {
        setInputText(focusSnapshot.current.text);
        setSelectedAccount(focusSnapshot.current.account);
      }
      setOpen(false);
      setSearchState('idle');
    }, 150);
  }

  function commitSelection(account: SapAccount) {
    setInputText(accountLabel(account));
    setSelectedAccount(account);
    setResults([]);
    setOpen(false);
    setSearchState('idle');
    onChange(account.acctCode);
  }

  function handleClear(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setInputText('');
    setSelectedAccount(null);
    setResults([]);
    setOpen(false);
    setSearchState('idle');
    onChange('');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open && results.length > 0) setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && activeIndex >= 0 && results[activeIndex]) {
        e.preventDefault();
        commitSelection(results[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setInputText(focusSnapshot.current.text);
      setSelectedAccount(focusSnapshot.current.account);
    }
  }

  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const el = listRef.current.children[activeIndex] as HTMLElement;
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const isLoading = searchState === 'loading';
  const isEmpty = searchState === 'empty';
  const isError = searchState === 'error';

  return (
    <div ref={containerRef} className="relative">
      <div className="relative flex items-center">
        <input
          className={[
            'app-input h-8 px-2 py-1 text-xs font-mono pr-6 w-full',
            selectedAccount ? 'text-success' : '',
            className ?? '',
          ].join(' ')}
          value={inputText}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? 'Code ou libellé compte SAP…'}
          disabled={disabled}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={open}
        />
        {isLoading && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
            <span className="h-3 w-3 animate-spin rounded-full border border-primary border-t-transparent inline-block" />
          </span>
        )}
        {!isLoading && inputText && !disabled && (
          <button
            type="button"
            onMouseDown={handleClear}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            tabIndex={-1}
            aria-label="Effacer"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-80 rounded-lg border border-border/70 bg-popover shadow-lg">
          {results.length > 0 && (
            <ul ref={listRef} role="listbox" className="max-h-52 overflow-y-auto">
              {results.map((a, i) => (
                <li key={a.acctCode} role="option" aria-selected={i === activeIndex}>
                  <button
                    type="button"
                    className={[
                      'flex w-full items-baseline gap-2 px-3 py-2 text-left text-xs',
                      i === activeIndex ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/60',
                    ].join(' ')}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commitSelection(a);
                    }}
                    onMouseEnter={() => setActiveIndex(i)}
                  >
                    <span className="font-mono font-semibold text-foreground flex-shrink-0">
                      {a.acctCode}
                    </span>
                    <span className="truncate text-muted-foreground">— {a.acctName}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {isEmpty && (
            <div className="px-3 py-3 text-xs text-muted-foreground space-y-1.5">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-warning" />
                Aucun compte SAP trouvé
              </div>
              {onSyncRequest ? (
                <>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void handleSync();
                    }}
                    disabled={syncing}
                    className="flex items-center gap-1.5 text-[11px] text-primary hover:underline disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`} />
                    {syncing ? 'Synchronisation en cours…' : 'Synchroniser le plan comptable'}
                  </button>
                  {syncError && (
                    <p className="text-[11px] text-destructive leading-relaxed">{syncError}</p>
                  )}
                </>
              ) : (
                <p className="text-[11px] leading-relaxed">
                  Si le plan comptable n'est pas encore synchronisé, rendez-vous dans{' '}
                  <strong>Paramètres → Resynchroniser plan comptable SAP</strong>.
                </p>
              )}
            </div>
          )}

          {isError && (
            <div className="px-3 py-3 text-xs text-destructive">
              <div className="flex items-center gap-1.5 font-medium">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                Erreur de communication avec l'API SAP
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
