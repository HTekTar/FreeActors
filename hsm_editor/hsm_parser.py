import json

class Transition:
    def __init__(self, id, sig, target=None, action=None):
        self.id = id
        self.sig = sig
        self.target = target
        self.action = action

    def __repr__(self):
        return (f"Transition(id='{self.id}', sig='{self.sig}', target='{self.target}', "
                f"action='{self.action}')")

class State:
    def __init__(self, id, super_state, transitions=None, trans=None):
        self.id = id
        self.super_state = super_state
        self.transitions = transitions if transitions else []
        self.trans = trans if trans else []

    def __repr__(self):
        return (f"State(id='{self.id}', super_state='{self.super_state}', "
                f"transitions={self.transitions}, trans={self.trans})")

class StateMachineParser:
    def __init__(self, file_path):
        self.file_path = file_path
        self.data = self._load_json_from_file()
        self.states = {}
        self.transitions = {}
        self._parse_transitions()
        self._parse_states()

    def _load_json_from_file(self):
        try:
            with open(self.file_path, 'r') as file:
                return json.load(file)
        except FileNotFoundError:
            print(f"Error: The file '{self.file_path}' was not found.")
            return None
        except json.JSONDecodeError:
            print(f"Error: The file '{self.file_path}' is not a valid JSON.")
            return None

    def _parse_transitions(self):
        if self.data and 'transitions' in self.data:
            for t_data in self.data['transitions']:
                transition = Transition(
                    id=t_data.get('id'),
                    sig=t_data.get('sig'),
                    target=t_data.get('target'),
                    action=t_data.get('action')
                )
                self.transitions[transition.id] = transition

    def _parse_states(self):
        if self.data and 'states' in self.data:
            for s_data in self.data['states']:
                state = State(
                    id=s_data.get('id'),
                    super_state=s_data.get('super'),
                    transitions=s_data.get('transitions'),
                    trans=s_data.get('trans')
                )
                # Note: This will overwrite states with the same ID.
                self.states[state.id] = state

    def get_parsed_data(self):
        """
        Returns a dictionary containing the parsed State and Transition objects.
        """
        if self.data is None:
            return {"states": {}, "transitions": {}}
        return {
            "states": self.states,
            "transitions": self.transitions
        }

# ---
# To make this code runnable, let's create a sample JSON file first.

# The JSON data to be saved to a file
json_data = {
    "states": [
        {
            "id": "s1",
            "super": "s0",
            "transitions": [
                "i1"
            ]
        },
        {
            "id": "s1",
            "super": "s0",
            "trans": [
                "t1", "t2"
            ]
        }
    ],
    "transitions": [
        {
            "id": "i1",
            "sig": "INIT",
            "target": "s1",
            "action": "initialize"
        },
        {
            "id": "t1",
            "sig": "B",
            "target": "s11"
        },
        {
            "id": "t2",
            "sig": "A",
            "action": "initialize"
        }
    ]
}

file_name = "state_machine.json"
with open(file_name, 'w') as f:
    json.dump(json_data, f, indent=4)

if __name__ == '__main__':
    # Use the file name as the input to the parser
    parser = StateMachineParser(file_name)
    parsed_data = parser.get_parsed_data()

    if parsed_data['states'] or parsed_data['transitions']:
        print("Successfully parsed data from file:")
        print("Parsed Transitions:")
        for id, transition in parsed_data['transitions'].items():
            print(f"  {transition}")

        print("\nParsed States:")
        for id, state in parsed_data['states'].items():
            print(f"  {state}")

        # Example of how to access the parsed objects
        state_s1 = parsed_data['states']['s1']
        print(f"\nDetails for state 's1':")
        print(f"  Super state: {state_s1.super_state}")
        # Be careful here, as the second 's1' in the JSON overwrites the first.
        # It has no 'transitions' attribute, only 'trans'.
        print(f"  Transitions from JSON: {state_s1.trans}")