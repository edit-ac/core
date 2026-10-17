/** Static PNG/JPEG only. Never send SVG or animation to a browser decoder. */
export interface ImageLimits { encodedBytes: number; dimension: number; pixels: number; concurrency: number; timeoutMs: number }
export const DEFAULT_IMAGE_LIMITS: Readonly<ImageLimits> = Object.freeze({ encodedBytes: 8_388_608, dimension: 8192, pixels: 16_777_216, concurrency: 2, timeoutMs: 10_000 });
export function imageLimits(value: Partial<ImageLimits> = {}): Readonly<ImageLimits> {
  const result = { ...DEFAULT_IMAGE_LIMITS, ...value };
  for (const key of Object.keys(result) as (keyof ImageLimits)[]) if (!Number.isSafeInteger(result[key]) || result[key] <= 0 || result[key] > DEFAULT_IMAGE_LIMITS[key]) throw Error('Invalid image limits');
  return Object.freeze(result);
}
export function inspectImage(bytes: Uint8Array, limits: ImageLimits): { type: string; width: number; height: number } {
  if (!bytes.length || bytes.length > limits.encodedBytes) throw Error('encoded-byte-limit');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, type = '';
  if (bytes.length >= 33 && [137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b)) {
    type = 'image/png'; let at = 8, ended = false, header = false, data = false;
    while (at + 12 <= bytes.length) {
      const size = view.getUint32(at), tag = String.fromCharCode(...bytes.subarray(at+4,at+8));
      if (size > bytes.length-at-12) throw Error('malformed');
      if (!header) { if (tag !== 'IHDR' || size !== 13) throw Error('malformed'); width=view.getUint32(at+8); height=view.getUint32(at+12); header=true; }
      else if (tag === 'IHDR') throw Error('malformed');
      if (['acTL','fcTL','fdAT'].includes(tag)) throw Error('animated-unsupported');
      if (tag === 'IDAT') data=true;
      at += size+12;
      if (tag === 'IEND') { if (size || at !== bytes.length) throw Error('malformed'); ended=true; break; }
    }
    if (!ended || !data) throw Error('malformed');
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    type = 'image/jpeg'; let at = 2;
    while (at+4 <= bytes.length) {
      if (bytes[at++] !== 255) throw Error('malformed');
      while (bytes[at] === 255) at++;
      const marker = bytes[at++]!;
      if (marker === 218 || marker === 217) break;
      const size = view.getUint16(at);
      if (size < 2 || at+size > bytes.length) throw Error('malformed');
      if ([192,193,194].includes(marker)) { if (size < 8 || width) throw Error('malformed'); height=view.getUint16(at+3); width=view.getUint16(at+5); }
      at += size;
    }
    if (bytes.at(-2)!==255 || bytes.at(-1)!==217) throw Error('malformed');
  } else throw Error('media-unsupported');
  if (!width || !height) throw Error('malformed');
  if (width > limits.dimension || height > limits.dimension || width*height > limits.pixels) throw Error('decoded-size-limit');
  return { type, width, height };
}
/** Browsers can tolerate corrupt compressed PNGs. Validate their CRC and bounded
 * inflated scanline envelope independently before invoking the image decoder.
 * This first profile admits noninterlaced 8-bit grayscale/RGB/alpha PNGs. */
export async function validateImagePayload(bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  if (bytes[0] !== 137) return;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), width=view.getUint32(16), height=view.getUint32(20);
  const channels=({0:1,2:3,4:2,6:4} as Record<number,number>)[bytes[25]!];
  if(bytes[24]!==8 || !channels || bytes[26]!==0 || bytes[27]!==0 || bytes[28]!==0)throw Error('png-profile-unsupported');
  const parts:Uint8Array<ArrayBuffer>[]=[];
  for(let at=8;at+12<=bytes.length;){
    const size=view.getUint32(at);let crc=0xffffffff;
    for(let i=at+4;i<at+8+size;i++){crc^=bytes[i]!;for(let b=0;b<8;b++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    if((crc^0xffffffff)>>>0!==view.getUint32(at+8+size))throw Error('malformed');
    if(String.fromCharCode(...bytes.subarray(at+4,at+8))==='IDAT')parts.push(bytes.slice(at+8,at+8+size));
    at+=size+12;
  }
  if(typeof DecompressionStream!=='function')throw Error('decoder-unavailable');
  const stream=new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate')), reader=stream.getReader();
  const row=width*channels+1, expected=row*height;let count=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try {
    while(true){if(signal.aborted)throw Error('canceled');const part=await reader.read();if(part.done)break;
      if(count+part.value.length>expected)throw Error('malformed');
      for(let at=(row-count%row)%row;at<part.value.length;at+=row)if(part.value[at]!>4)throw Error('malformed');
      count+=part.value.length;
    }
    if(count!==expected)throw Error('malformed');
  }catch{throw Error(signal.aborted?'canceled':'malformed');}
  finally{signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
