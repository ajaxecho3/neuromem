import { useQuery } from "@tanstack/react-query";
import { getAgents } from "../api/agents";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  value: string;
  onChange: (v: string) => void;
}

export function AgentSelector({ value, onChange }: Props) {
  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: getAgents,
  });
  return (
    <Select value={value} onValueChange={(e) => onChange(e)}>
      <SelectTrigger className="h-9 min-w-32">
        <SelectValue placeholder="Select agent config" />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value="all">All agents</SelectItem>
        {agents.map((a) => (
          <SelectItem key={a} value={a}>
            {a}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
