from transformers import AutoTokenizer, AutoModelForTokenClassification
from transformers import pipeline
from transformers import TextClassificationPipeline, RobertaForSequenceClassification, RobertaTokenizer


# model_name = "dbmdz/bert-large-cased-finetuned-conll03-english"

# tokenizer = AutoTokenizer.from_pretrained(model_name)
# model = AutoModelForTokenClassification.from_pretrained(model_name)

# nlp = pipeline("ner", model=model, tokenizer=tokenizer)
# example = """The paper presents a wireless sensor network-based mobile countersniper system. A sensor node consists of a helmetmounted microphone array, a COTS MICAz mote for internode communication and a custom sensorboard that implements the acoustic detection and Time of Arrival (ToA) estimation algorithms on an FPGA. A 3-axis compass provides self orientation and Bluetooth is used for communication with the soldier's PDA running the data fusion and the user interface.
# """

# ner_results = nlp(example)
# print(ner_results)


CODEBERTA_LANGUAGE_ID = "huggingface/CodeBERTa-language-id"

# tokenizer = RobertaTokenizer.from_pretrained(CODEBERTA_LANGUAGE_ID)
# model = RobertaForSequenceClassification.from_pretrained(CODEBERTA_LANGUAGE_ID)

# input_ids = tokenizer.encode(CODE_TO_IDENTIFY)
# logits = model(input_ids)[0]

# language_idx = logits.argmax() # index for the resulting label

CODE_TO_IDENTIFY = """if [ -n x ]
  echo $ENV
fi"""

pipeline = TextClassificationPipeline(
    model=RobertaForSequenceClassification.from_pretrained(CODEBERTA_LANGUAGE_ID),
    tokenizer=RobertaTokenizer.from_pretrained(CODEBERTA_LANGUAGE_ID)
)

print(pipeline(CODE_TO_IDENTIFY))
