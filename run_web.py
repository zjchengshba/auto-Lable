"""Web UI entry: python run_web.py [--host 127.0.0.1 --port 8000]"""
from web.app import create_app

app = create_app()

if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    a = p.parse_args()
    app.run(host=a.host, port=a.port, debug=False, threaded=True)
