import json


def get_gpu_info() -> dict:
    try:
        import torch

        cuda_available = bool(torch.cuda.is_available())
        device_count = int(torch.cuda.device_count()) if cuda_available else 0
        devices = [torch.cuda.get_device_name(i) for i in range(device_count)] if cuda_available else []
        current_device = torch.cuda.get_device_name(0) if cuda_available and device_count > 0 else 'cpu'

        return {
            'cudaAvailable': cuda_available,
            'cudaVersion': torch.version.cuda,
            'torchVersion': torch.__version__,
            'deviceCount': device_count,
            'currentDevice': current_device,
            'devices': devices,
        }
    except Exception as exc:
        return {
            'cudaAvailable': False,
            'cudaVersion': None,
            'torchVersion': f'Error: {exc}',
            'deviceCount': 0,
            'currentDevice': 'cpu',
            'devices': [],
        }


if __name__ == '__main__':
    print(json.dumps(get_gpu_info(), ensure_ascii=False))
