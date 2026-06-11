from transformers import BertTokenizer, BertForSequenceClassification
import torch
 
# Load pre-trained model and tokenizer
model_name = 'allenai/scibert_scivocab_uncased'
tokenizer = BertTokenizer.from_pretrained(model_name)
model = BertForSequenceClassification.from_pretrained(
    model_name,
    num_labels=2,  # Adjust based on your classification task
    output_attentions=False,
    output_hidden_states=False
)

def batch_classify(texts, model, tokenizer, batch_size=32):
    results = []
     
    for i in range(0, len(texts), batch_size):
        batch_texts = texts[i:i+batch_size]
         
        inputs = tokenizer(
            batch_texts,
            return_tensors='pt',
            truncation=True,
            padding=True,
            max_length=512
        )
         
        with torch.no_grad():
            outputs = model(**inputs)
            predictions = torch.argmax(outputs.logits, dim=1)
            confidences = torch.nn.functional.softmax(outputs.logits, dim=-1)
         
        batch_results = []
        for j, text in enumerate(batch_texts):
            batch_results.append({
                'text': text,
                'prediction': predictions[j].item(),
                'confidence': confidences[j][predictions[j]].item()
            })
         
        results.extend(batch_results)
     
    return results

def classify_documents(documents, model, tokenizer, categories):
    classified_docs = []
     
    for doc in documents:
        inputs = tokenizer(
            doc['content'],
            return_tensors='pt',
            truncation=True,
            padding=True,
            max_length=512
        )
         
        with torch.no_grad():
            outputs = model(**inputs)
            predicted_class = torch.argmax(outputs.logits, dim=1).item()
         
        classified_docs.append({
            'title': doc['title'],
            'predicted_category': predicted_class,
            'confidence': torch.nn.functional.softmax(outputs.logits, dim=-1)[0][predicted_class].item()
        })
     
    return classified_docs

print(classify_documents([{'title': 'README.md', 'content': """# Knowledge Graph Generator

> 🧠 Transform your codebase into intelligent knowledge graphs using local LLMs

An advanced CLI tool that analyzes files, extracts meaningful entities and relationships, and builds comprehensive knowledge graphs. Perfect for understanding complex codebases, research projects, and documentation systems.
"""}], model, tokenizer, []))