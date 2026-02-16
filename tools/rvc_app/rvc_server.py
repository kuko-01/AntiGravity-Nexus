import argparse
import base64
import os
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
import uvicorn

app = FastAPI(title='RVC Server', version='0.1.0')


class SetModelRequest(BaseModel):
    model_id: str


class ConvertRequest(BaseModel):
    model_id: Optional[str] = None
    input_path: Optional[str] = None
    input_base64: Optional[str] = None
    f0_method: str = 'rmvpe'
    transpose: int = 0
    index_rate: float = 0.75
    protect: float = 0.33
    filter_radius: int = 3
    rms_mix_rate: float = 0.25
    resample_sr: int = 0


state = {
    'active_model': None,
}


@app.get('/health')
def health() -> dict:
    return {
        'status': 'ok',
        'active_model': state['active_model'],
    }


@app.post('/models/set')
def set_model(payload: SetModelRequest) -> dict:
    state['active_model'] = payload.model_id
    return {'success': True, 'active_model': state['active_model']}


@app.post('/convert')
def convert(payload: ConvertRequest):
    # Stub implementation for integration testing:
    # pass through the input WAV bytes until full RVC inference is wired.
    model_id = payload.model_id or state['active_model']
    if not model_id:
        raise HTTPException(status_code=400, detail='model_id is required')

    wav_bytes: Optional[bytes] = None

    if payload.input_path:
        if not os.path.exists(payload.input_path):
            raise HTTPException(status_code=404, detail=f'input_path not found: {payload.input_path}')
        with open(payload.input_path, 'rb') as f:
            wav_bytes = f.read()
    elif payload.input_base64:
        try:
            wav_bytes = base64.b64decode(payload.input_base64)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f'input_base64 decode failed: {exc}') from exc
    else:
        raise HTTPException(status_code=400, detail='input_path or input_base64 is required')

    if not wav_bytes:
        raise HTTPException(status_code=400, detail='input audio is empty')

    # TODO: Replace with real RVC inference pipeline.
    return Response(content=wav_bytes, media_type='audio/wav')


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=50031)
    parser.add_argument('--cpu', action='store_true')
    return parser.parse_args()


if __name__ == '__main__':
    args = parse_args()
    uvicorn.run(app, host='127.0.0.1', port=args.port, log_level='info')
