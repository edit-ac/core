import { errorMessage } from '../errors.js';
import type {ClipboardOutcome} from './fragment.js';

/** An owned preparation job. Source is kept after cancellation/rejection so a
 * host can offer recovery. Scheduling never owns or mutates document content. */
export class PendingPaste {
  readonly source: Readonly<Record<string,string>>;
  readonly result: Promise<ClipboardOutcome>;
  state: 'pending'|'applying'|'committed'|'rejected'|'canceled' = 'pending';
  readonly timings = {capturedBytes:0, preparationMs:0, applyMs:0, elapsedMs:0};
  #stop!: () => void;
  readonly #status: HTMLElement;
  constructor(document: Document, source: Record<string,string>, run: (job: PendingPaste) => Promise<ClipboardOutcome>, release: () => void) {
    this.source = Object.freeze({...source});
    this.timings.capturedBytes = Object.values(source).reduce((n,s)=>n+new TextEncoder().encode(s).length,0);
    const start = performance.now();
    this.#status = document.createElement('div'); this.#status.setAttribute('role','status'); this.#status.setAttribute('aria-live','polite');
    this.#status.append('Preparing paste. ');
    const button = document.createElement('button'); button.type='button'; button.textContent='Cancel paste'; button.onclick=()=>this.cancel(); this.#status.append(button);
    document.body.append(this.#status);
    const cancellation = new Promise<ClipboardOutcome>(resolve=>{this.#stop=()=>resolve({disposition:'rejected',reason:'clipboard-canceled'});});
    this.result = Promise.race([Promise.resolve().then(()=>run(this)), cancellation]).then(outcome=>{
      if (this.state==='pending'||this.state==='applying') this.state=outcome.disposition==='committed'?'committed':'rejected';
      return outcome;
    }).catch(error=>{this.state='rejected';return {disposition:'rejected',reason:errorMessage(error)} as ClipboardOutcome;})
      .finally(()=>{this.timings.elapsedMs=performance.now()-start;this.#status.remove();release();});
  }
  get active(): boolean {return this.state==='pending';}
  beginApply(): boolean {if(!this.active)return false;this.state='applying';this.#status.textContent='Applying paste.';return true;}
  cancel(): void {if(!this.active)return;this.state='canceled';this.#stop();}
}
