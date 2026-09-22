# ==========================================
# CetraOps / SIÉ Joy OS - Dockerfile
# ==========================================
FROM python:3.11-slim

WORKDIR /app

# Variáveis de ambiente padrão do Python e da aplicação
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=3001 \
    HOST=0.0.0.0

# Instalação de dependências
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Cópia do código-fonte da aplicação web
COPY sistema_web/ ./sistema_web/

# Volume para persistência local de dados JSON
VOLUME ["/app/sistema_web/data"]

EXPOSE 3001

# Inicialização do servidor web
CMD ["python", "sistema_web/server.py"]
