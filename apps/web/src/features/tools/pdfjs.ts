import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function openPdf(file: File) {
  const data = new Uint8Array(await file.arrayBuffer());
  return pdfjs.getDocument({ data, isEvalSupported: false }).promise;
}

export { pdfjs };
