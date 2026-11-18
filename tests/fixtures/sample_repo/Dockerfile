FROM python:3.12-slim
COPY . /app
RUN pip install /app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0"]
