export interface InboxFile {
  /** Nom du fichier (ex: "FAC-2026-001.xml") */
  filename: string;
  /** Chemin absolu sur le disque */
  absolutePath: string;
  /** Extension en minuscules (ex: ".xml", ".pdf") */
  ext: string;
}
