# ---- Base Node image ----
FROM node:18-slim

# ---- Install system dependencies (for sharp + tesseract) ----
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    make \
    gcc \
    g++ \
    libc6-dev \
    libvips-dev \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-hin \
    tesseract-ocr-mar \
    && rm -rf /var/lib/apt/lists/*

# ---- App directory ----
WORKDIR /app

# ---- Copy package.json and install ----
COPY package*.json ./
RUN npm install --production

# ---- Copy source code ----
COPY . .

# ---- Expose port ----
EXPOSE 3000

# ---- Start ----
CMD ["npm", "start"]
