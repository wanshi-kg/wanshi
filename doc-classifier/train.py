from transformers import AutoTokenizer, AutoModelForSequenceClassification, TrainingArguments, Trainer
import torch
from torch.utils.data import Dataset
import pandas as pd

class DocumentDataset(Dataset):
    def __init__(self, texts, labels, tokenizer, max_length=512):
        self.texts = texts
        self.labels = labels
        self.tokenizer = tokenizer
        self.max_length = max_length
    
    def __len__(self):
        return len(self.texts)
    
    def __getitem__(self, idx):
        text = str(self.texts[idx])
        encoding = self.tokenizer(
            text,
            truncation=True,
            padding='max_length',
            max_length=self.max_length,
            return_tensors='pt'
        )
        
        return {
            'input_ids': encoding['input_ids'].flatten(),
            'attention_mask': encoding['attention_mask'].flatten(),
            'labels': torch.tensor(self.labels[idx], dtype=torch.long)
        }

# Initialize
model_name = "bert-base-uncased"  # or "distilbert-base-uncased" for speed
tokenizer = AutoTokenizer.from_pretrained(model_name)

#   | "research" // hypotheses, experiments, methodologies, results, datasets
#   | "communication" // people, organizations, projects, commitments, threads
#   | "documentation" // features, procedures, examples, requirements, guides
#   | "technical" // systems, services, configurations, logs, infrastructure
#   | "narrative" // topics, concepts, events, general prose content
#   | "reference"; // definitions, lists, catalogs, structured facts

# Create label mapping
labels = [
    "article_news",
    "article_blogpost",
    "article_tutorial",
    "article_academic",
    
    "code_python",
    "code_javascript",
    "code_typescript",
    "code_java",
    "code_csharp",
    "code_cpp",
    "code_c",
    "code_go",
    "code_rust",
    "code_other",
    
    "config_",
    "config_",
    "config_",
    
    "email_spam",
    "email_fishing",
    "email_personal",
    "email_work",
    "email_invoice",
    "email_newsletter",
    
    "financial_contract",
    "financial_invoice",
    "financial_receipt",
    "financial_bank_statetment",
    "financial_tax_return",
    "financial_audit_report",
    "financial_budget_report",
    "financial_investment_report",
    "financial_insurance_policy",
    "financial_loan",
    "financial_credit_report",
    "financial_projection_report",
    "financial_compliance",
    "financial_annual_report",
    "financial_shareholder_report",
    "financial_report",

    "generic",

    "legal_contract",
    "legal_court_case",
    "legal_court_order",
    "legal_court_decision",
    "legal_statute",
    "legal_legislation",
    
    "logs",
    
    "medical_test_results",
    "medical_scan_report",
    "medical_prescription",
    "medical_diagnosis",
    "medical_treatment",
    "medical_medication",
    "medical_other",

    "notes_",

    "tabular_financial",
    "tabular_sales",
    "tabular_inventory",
    "tabular_hr",
    "tabular_marketing",
    "tabular_operations",
    "tabular_other",
    
    "transcript_meeting",
    "transcript_interview",
    "transcript_lecture",
    "transcript_podcast",
]

label2id = {label: i for i, label in enumerate(labels)}
id2label = {i: label for label, i in label2id.items()}

# Load model
model = AutoModelForSequenceClassification.from_pretrained(
    model_name, 
    num_labels=len(labels),
    id2label=id2label,
    label2id=label2id
)

# Training setup
training_args = TrainingArguments(
    output_dir='./results',
    num_train_epochs=3,
    per_device_train_batch_size=16,
    per_device_eval_batch_size=64,
    warmup_steps=500,
    weight_decay=0.01,
    logging_dir='./logs',
    evaluation_strategy="epoch",
    save_strategy="epoch",
    load_best_model_at_end=True,
)

# Assuming you have train_texts, train_labels, val_texts, val_labels
train_dataset = DocumentDataset(train_texts, train_labels, tokenizer)
val_dataset = DocumentDataset(val_texts, val_labels, tokenizer)

trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=train_dataset,
    eval_dataset=val_dataset,
)

# Train
trainer.train()