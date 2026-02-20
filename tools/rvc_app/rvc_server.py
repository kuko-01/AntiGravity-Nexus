import argparse
import base64
import io
import os
import sys
import threading
import urllib.request
import wave
from dataclasses import dataclass
from tempfile import NamedTemporaryFile
from typing import Dict, Optional, Tuple

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
import uvicorn

app = FastAPI(title='RVC Server', version='1.0.0')

VERBOSE_LOG = os.environ.get('RVC_VERBOSE_LOG', '0') == '1'


HUBERT_URL = "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/hubert_base.pt"
RMVPE_URL = "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/rmvpe.pt"


def vprint(message: str) -> None:
    if VERBOSE_LOG:
        print(message)


class SetModelRequest(BaseModel):
    model_id: str


class ConvertRequest(BaseModel):
    model_id: Optional[str] = None
    index_path: Optional[str] = None
    speaker_id: int = 0
    input_path: Optional[str] = None
    input_base64: Optional[str] = None
    f0_method: str = 'rmvpe'
    transpose: int = 0
    index_rate: float = 0.75
    protect: float = 0.33
    filter_radius: int = 3
    rms_mix_rate: float = 0.25
    resample_sr: int = 0


@dataclass
class ModelEntry:
    model_id: str
    sid_name: str
    pth_path: str
    index_path: Optional[str]


class OfficialRvcBackend:
    def __init__(self, force_cpu: bool):
        self.force_cpu = force_cpu
        this_file = globals().get('__file__')
        if this_file:
            self.server_dir = os.path.dirname(os.path.abspath(this_file))
        else:
            self.server_dir = os.getcwd()
        self.official_root = os.path.join(self.server_dir, 'rvc_official')
        self.models_root = os.path.abspath(
            os.environ.get('RVC_MODELS_DIR') or os.path.join(self.server_dir, '..', 'models')
        )
        self.index_root = self.models_root
        self.assets_hubert = os.path.join(self.official_root, 'assets', 'hubert')
        self.assets_rmvpe = os.path.join(self.official_root, 'assets', 'rmvpe')
        self.active_model: Optional[str] = None
        self.vc = None
        self.config = None
        self.model_cache: Dict[str, ModelEntry] = {}
        self.lock = threading.Lock()
        self.initialized = False
        self.init_error: Optional[str] = None

    def _download_if_missing(self, url: str, output_path: str) -> None:
        if os.path.exists(output_path):
            return
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        print(f'[RVC] Downloading required asset: {url} -> {output_path}')
        urllib.request.urlretrieve(url, output_path)

    def _discover_models(self) -> Dict[str, ModelEntry]:
        entries: Dict[str, ModelEntry] = {}
        if not os.path.isdir(self.models_root):
            return entries

        for name in os.listdir(self.models_root):
            path = os.path.join(self.models_root, name)
            if os.path.isfile(path) and name.lower().endswith('.pth'):
                model_id = os.path.splitext(name)[0]
                entries[model_id] = ModelEntry(
                    model_id=model_id,
                    sid_name=name,
                    pth_path=path,
                    index_path=None,
                )
                continue

            if not os.path.isdir(path):
                continue

            pth_files = [f for f in os.listdir(path) if f.lower().endswith('.pth')]
            if not pth_files:
                continue

            sid_name = pth_files[0]
            pth_path = os.path.join(path, sid_name)
            idx = None
            for f in os.listdir(path):
                lf = f.lower()
                if lf.endswith('.index') and 'trained' not in lf:
                    idx = os.path.join(path, f)
                    break
                if lf.endswith('.ivf'):
                    idx = os.path.join(path, f)

            entries[name] = ModelEntry(
                model_id=name,
                sid_name=sid_name,
                pth_path=pth_path,
                index_path=idx,
            )
        return entries

    def initialize(self) -> None:
        if self.initialized:
            return
        if self.init_error:
            raise RuntimeError(self.init_error)

        try:
            if not os.path.isdir(self.official_root):
                raise RuntimeError(f'Official RVC core missing: {self.official_root}')

            os.makedirs(self.models_root, exist_ok=True)
            os.makedirs(self.assets_hubert, exist_ok=True)
            os.makedirs(self.assets_rmvpe, exist_ok=True)

            hubert_path = os.path.join(self.assets_hubert, 'hubert_base.pt')
            rmvpe_path = os.path.join(self.assets_rmvpe, 'rmvpe.pt')
            self._download_if_missing(HUBERT_URL, hubert_path)
            self._download_if_missing(RMVPE_URL, rmvpe_path)

            os.environ['weight_root'] = self.models_root
            os.environ['index_root'] = self.index_root
            os.environ['outside_index_root'] = self.index_root
            os.environ['rmvpe_root'] = self.assets_rmvpe
            os.environ['hubert_model_path'] = hubert_path

            if self.official_root not in sys.path:
                sys.path.insert(0, self.official_root)

            cwd_prev = os.getcwd()
            argv_prev = sys.argv[:]
            try:
                os.chdir(self.official_root)
                sys.argv = [sys.argv[0]]
                from configs.config import Config  # type: ignore
                from infer.modules.vc.modules import VC  # type: ignore

                self.config = Config()
                if self.force_cpu:
                    self.config.device = 'cpu'
                    self.config.is_half = False
                # Prefer fp32 for quality/stability. Set RVC_FORCE_FP16=1 to opt in.
                if os.environ.get('RVC_FORCE_FP16', '0') != '1':
                    self.config.is_half = False
                self.vc = VC(self.config)
            finally:
                sys.argv = argv_prev
                os.chdir(cwd_prev)

            self.initialized = True
            precision = 'fp16' if getattr(self.config, 'is_half', False) else 'fp32'
            print(
                f'[RVC] Official backend initialized. models_root={self.models_root}, '
                f'device={self.config.device}, precision={precision}'
            )
        except Exception as exc:
            self.init_error = str(exc)
            raise

    def list_models(self) -> Dict[str, ModelEntry]:
        self.initialize()
        self.model_cache = self._discover_models()
        return self.model_cache

    def set_model(self, model_id: str) -> ModelEntry:
        with self.lock:
            models = self.list_models()
            if model_id not in models:
                raise HTTPException(status_code=404, detail=f'model_id not found: {model_id}')
            entry = models[model_id]
            # VC.get_vc expects a sid file name existing in weight_root.
            self.vc.get_vc(entry.sid_name)
            self.active_model = model_id
            return entry

    @staticmethod
    def _encode_wav_bytes(sr: int, audio: np.ndarray) -> bytes:
        x = np.asarray(audio)
        if x.size == 0:
            raise HTTPException(status_code=400, detail='converted audio is empty')

        # Ensure mono stream for WAV writing.
        if x.ndim > 1:
            x = np.mean(x, axis=-1)

        if np.issubdtype(x.dtype, np.integer):
            # Official RVC pipeline already returns int16 in most cases.
            i16 = np.clip(x, -32768, 32767).astype(np.int16)
        else:
            xf = np.asarray(x, dtype=np.float32)
            max_abs = float(np.max(np.abs(xf))) if xf.size else 0.0
            if max_abs > 1.5:
                # Some paths may return float values in PCM scale already.
                i16 = np.clip(xf, -32768.0, 32767.0).astype(np.int16)
            else:
                i16 = (np.clip(xf, -1.0, 1.0) * 32767.0).astype(np.int16)
        raw = i16.tobytes()
        out = io.BytesIO()
        with wave.open(out, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(int(sr))
            wf.writeframes(raw)
        return out.getvalue()

    def _resolve_input_path(self, payload: ConvertRequest) -> Tuple[str, bool]:
        """Resolve audio input to a file path.

        Returns (path, is_temp) -- when is_temp is True the caller must delete
        the file after use.

        Matches official RVC2 approach: vc_single expects a file path which
        load_audio opens via ffmpeg/soundfile.  When the caller already has a
        file on disk we pass that path directly (no copy) to avoid unnecessary
        I/O and potential encoding issues.
        """
        if payload.input_path:
            if not os.path.exists(payload.input_path):
                raise HTTPException(status_code=404, detail=f'input_path not found: {payload.input_path}')
            return (payload.input_path, False)

        if payload.input_base64:
            try:
                data = base64.b64decode(payload.input_base64)
            except Exception as exc:
                raise HTTPException(status_code=400, detail=f'input_base64 decode failed: {exc}') from exc
            if not data:
                raise HTTPException(status_code=400, detail='input audio is empty')
            tmp = NamedTemporaryFile(suffix='.wav', delete=False)
            try:
                tmp.write(data)
                tmp.flush()
                tmp.close()
            except Exception:
                tmp.close()
                try:
                    os.remove(tmp.name)
                except Exception:
                    pass
                raise
            return (tmp.name, True)

        raise HTTPException(status_code=400, detail='input_path or input_base64 is required')

    def convert(self, payload: ConvertRequest) -> bytes:
        with self.lock:
            self.initialize()
            model_id = payload.model_id or self.active_model
            if not model_id:
                raise HTTPException(status_code=400, detail='model_id is required')

            models = self.list_models()
            if model_id not in models:
                raise HTTPException(status_code=404, detail=f'model_id not found: {model_id}')
            entry = models[model_id]

            # Ensure requested model is active.
            if self.active_model != model_id:
                self.vc.get_vc(entry.sid_name)
                self.active_model = model_id

            file_index = entry.index_path or ''
            if payload.index_path:
                requested_index = os.path.abspath(payload.index_path)
                if not os.path.exists(requested_index):
                    raise HTTPException(status_code=400, detail=f'index_path not found: {payload.index_path}')
                if not (requested_index.lower().endswith('.index') or requested_index.lower().endswith('.ivf')):
                    raise HTTPException(status_code=400, detail='index_path must be .index or .ivf')
                if 'trained' in os.path.basename(requested_index).lower():
                    raise HTTPException(
                        status_code=400,
                        detail='trained_*.index is not supported for inference; use added_*.index'
                    )
                model_dir = os.path.dirname(os.path.abspath(entry.pth_path))
                if os.path.dirname(requested_index) != model_dir:
                    raise HTTPException(status_code=400, detail='index_path must be in the same directory as the model .pth')
                file_index = requested_index
            index_rate = float(payload.index_rate)
            if not file_index:
                index_rate = 0.0
            protect = float(payload.protect)
            if protect < 0.0:
                protect = 0.0
            if protect > 0.5:
                protect = 0.5
            rms_mix_rate = float(payload.rms_mix_rate)
            if rms_mix_rate < 0.0:
                rms_mix_rate = 0.0
            if rms_mix_rate > 1.0:
                rms_mix_rate = 1.0
            filter_radius = int(payload.filter_radius)
            if filter_radius < 0:
                filter_radius = 0
            n_spk = 1
            try:
                n_spk = int(self.vc.cpt["config"][-3])
            except Exception:
                n_spk = 1
            sid = int(payload.speaker_id or 0)
            if n_spk > 0:
                if sid < 0:
                    sid = 0
                if sid >= n_spk:
                    sid = n_spk - 1

            # Resolve audio input -- pass file path directly when available
            # (matches official RVC2: vc_single receives a path for load_audio).
            input_path, is_temp = self._resolve_input_path(payload)

            # Detect model version & target SR for diagnostics
            model_version = getattr(self.vc, 'version', '?')
            model_tgt_sr = getattr(self.vc, 'tgt_sr', '?')

            vprint(
                f'[RVC] convert model={model_id} version={model_version} tgt_sr={model_tgt_sr} '
                f'pth={entry.pth_path} '
                f'index={file_index or "none"} f0={payload.f0_method or "rmvpe"} '
                f'sid={sid}/{n_spk} '
                f'transpose={int(payload.transpose or 0)} index_rate={index_rate:.2f} '
                f'protect={protect:.2f} rms_mix={rms_mix_rate:.2f} '
                f'filter_radius={filter_radius} resample_sr={int(payload.resample_sr)} '
                f'input={input_path} (temp={is_temp})'
            )

            try:
                info, wav_opt = self.vc.vc_single(
                    sid,
                    input_path,
                    int(payload.transpose or 0),
                    None,
                    payload.f0_method or 'rmvpe',
                    file_index,
                    None,
                    index_rate,
                    filter_radius,
                    int(payload.resample_sr),
                    rms_mix_rate,
                    protect,
                )

                # Log vc_single diagnostic info (e.g. "Index not used.", timing)
                vprint(f'[RVC] vc_single info: {info}')

                if not wav_opt or wav_opt[0] is None or wav_opt[1] is None:
                    raise HTTPException(status_code=400, detail=f'vc_single failed: {info}')

                sr, audio = wav_opt

                # Validate output
                audio_arr = np.asarray(audio)
                if audio_arr.size == 0:
                    raise HTTPException(status_code=400, detail='vc_single returned empty audio')
                max_abs = float(np.max(np.abs(audio_arr.astype(np.float64))))
                silence_threshold = 1.0 if np.issubdtype(audio_arr.dtype, np.integer) else 0.02
                if max_abs < silence_threshold:
                    print(f'[RVC] WARNING: output audio is near-silent (max_abs={max_abs:.4f})')
                vprint(
                    f'[RVC] output sr={sr} samples={audio_arr.shape[0]} '
                    f'duration={audio_arr.shape[0] / max(sr, 1):.2f}s '
                    f'dtype={audio_arr.dtype} max_abs={max_abs:.1f}'
                )

                out_bytes = self._encode_wav_bytes(sr, audio)
                return out_bytes
            finally:
                if is_temp:
                    try:
                        os.remove(input_path)
                    except Exception:
                        pass


backend: Optional[OfficialRvcBackend] = None


@app.get('/health')
def health() -> dict:
    if backend is None:
        return {'status': 'starting', 'active_model': None, 'device': None}
    if backend.init_error:
        return {'status': 'error', 'error': backend.init_error}
    if not backend.initialized:
        return {'status': 'starting', 'active_model': None, 'device': None}
    return {
        'status': 'ok',
        'active_model': backend.active_model,
        'device': backend.config.device if backend.config else None,
    }


@app.get('/models')
def list_models() -> dict:
    if backend is None:
        raise HTTPException(status_code=503, detail='backend not initialized')
    models = backend.list_models()
    return {
        'models': sorted(models.keys()),
        'models_root': backend.models_root,
        'active_model': backend.active_model,
    }


@app.post('/models/set')
def set_model(payload: SetModelRequest) -> dict:
    if backend is None:
        raise HTTPException(status_code=503, detail='backend not initialized')
    entry = backend.set_model(payload.model_id)
    speaker_count = None
    try:
        speaker_count = int(backend.vc.cpt["config"][-3])
    except Exception:
        speaker_count = None
    return {
        'success': True,
        'active_model': backend.active_model,
        'pth_path': entry.pth_path,
        'index_path': entry.index_path,
        'speaker_count': speaker_count,
    }


@app.post('/convert')
def convert(payload: ConvertRequest):
    if backend is None:
        raise HTTPException(status_code=503, detail='backend not initialized')
    out = backend.convert(payload)
    return Response(content=out, media_type='audio/wav')


@app.get('/debug')
def debug_info() -> dict:
    if backend is None:
        raise HTTPException(status_code=503, detail='backend not initialized')
    if not backend.initialized:
        raise HTTPException(status_code=503, detail='backend not initialized')

    info: dict = {
        'device': str(backend.config.device) if backend.config else None,
        'is_half': getattr(backend.config, 'is_half', None),
        'x_pad': getattr(backend.config, 'x_pad', None),
        'x_query': getattr(backend.config, 'x_query', None),
        'x_center': getattr(backend.config, 'x_center', None),
        'x_max': getattr(backend.config, 'x_max', None),
        'gpu_name': getattr(backend.config, 'gpu_name', None),
        'gpu_mem': getattr(backend.config, 'gpu_mem', None),
        'active_model': backend.active_model,
        'hubert_model_path': os.environ.get('hubert_model_path', ''),
        'hubert_model_path_exists': os.path.exists(os.environ.get('hubert_model_path', '')),
    }

    if backend.vc:
        info['model_version'] = getattr(backend.vc, 'version', None)
        info['model_tgt_sr'] = getattr(backend.vc, 'tgt_sr', None)
        info['model_if_f0'] = getattr(backend.vc, 'if_f0', None)
        info['model_n_spk'] = getattr(backend.vc, 'n_spk', None)

        hubert = getattr(backend.vc, 'hubert_model', None)
        if hubert is not None:
            info['hubert_type'] = type(hubert).__name__
            has_final_proj = hasattr(hubert, 'final_proj')
            info['hubert_has_final_proj'] = has_final_proj
            if has_final_proj:
                fp = hubert.final_proj
                info['hubert_final_proj_type'] = type(fp).__name__
                if hasattr(fp, 'weight'):
                    info['hubert_final_proj_shape'] = list(fp.weight.shape)
        else:
            info['hubert_type'] = 'not_loaded_yet'

        cpt = getattr(backend.vc, 'cpt', None)
        if cpt:
            info['cpt_config'] = [str(c) for c in cpt.get('config', [])]
            info['cpt_f0'] = cpt.get('f0')
            info['cpt_version'] = cpt.get('version')
            emb_w = cpt.get('weight', {}).get('emb_g.weight')
            if emb_w is not None:
                info['emb_g_weight_shape'] = list(emb_w.shape)

    return info


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=50031)
    parser.add_argument('--cpu', action='store_true')
    return parser.parse_args()


if __name__ == '__main__':
    args = parse_args()
    backend = OfficialRvcBackend(force_cpu=args.cpu)
    try:
        backend.initialize()
    except Exception as exc:
        print(f'[RVC] Backend initialization failed: {exc}')
    uvicorn.run(app, host='127.0.0.1', port=args.port, log_level='info', access_log=VERBOSE_LOG)
